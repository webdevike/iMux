import Foundation

/// Session registry + waiter parking for interactive panels.
///
/// Two modes share one pipeline:
/// - **prompt** (`cmux panel prompt`): one-shot. The RPC registers a session,
///   opens the split, and parks its socket-worker thread in `waitNext`; the
///   first submit/cancel resolves it and the session (and panel) is torn down.
/// - **live** (`cmux panel open/update/wait/read/close`): the session outlives
///   individual submits. Each submit is queued as an event; `panel.wait` calls
///   drain the queue (blocking when empty). `panel.update` swaps the stored
///   spec (the RPC layer pushes it into the page via JS). The session ends on
///   `panel.close`, a user cancel from the page, or app exit.
///
/// Trust: a token has exactly one session; the scheme handler serves the panel
/// bundle and the bridge accepts messages only while `hasActiveSession(token:)`
/// holds. Teardown therefore also revokes the page's bridge access.
final class PanelPromptCoordinator: @unchecked Sendable {
    static let shared = PanelPromptCoordinator()

    enum Mode: String {
        case prompt
        case live
    }

    enum Event {
        /// JSON-safe object posted by `panel.submit` (`params.value`).
        case submitted(Any)
        case cancelled
    }

    struct Session {
        let token: String
        let panelId: String
        var title: String
        /// Decoded JSON object handed to the page via `panel.init` (and
        /// re-pushed on `panel.update`).
        var spec: [String: Any]
        let mode: Mode
        let createdAt: Date
        /// Last value the page submitted; `panel.read` returns it.
        var lastSubmission: Any?
        /// Browser surface hosting the panel page; `panel.update` targets it.
        var surfaceId: UUID?
    }

    private final class Waiter {
        let semaphore = DispatchSemaphore(value: 0)
        var event: Event?
    }

    private let lock = NSLock()
    private var sessions: [String: Session] = [:]
    private var tokensByPanelId: [String: String] = [:]
    /// FIFO of parked `panel.wait` callers per token.
    private var waiters: [String: [Waiter]] = [:]
    /// Events submitted while nobody was waiting (live mode).
    private var pendingEvents: [String: [Event]] = [:]
    /// Registered after the browser split opens; run on teardown so the panel
    /// closes itself.
    private var closeHandlers: [String: @Sendable () -> Void] = [:]

    // MARK: Registration

    /// Registers a session. Returns false when `panelId` is already taken.
    @discardableResult
    func register(
        token: String,
        panelId: String,
        title: String,
        spec: [String: Any],
        mode: Mode,
        now: Date = Date()
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard tokensByPanelId[panelId] == nil else { return false }
        sessions[token] = Session(
            token: token,
            panelId: panelId,
            title: title,
            spec: spec,
            mode: mode,
            createdAt: now
        )
        tokensByPanelId[panelId] = token
        return true
    }

    func session(token: String) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        return sessions[token]
    }

    func session(panelId: String) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        guard let token = tokensByPanelId[panelId] else { return nil }
        return sessions[token]
    }

    func hasActiveSession(token: String) -> Bool {
        session(token: token) != nil
    }

    func setCloseHandler(token: String, handler: @escaping @Sendable () -> Void) {
        lock.lock()
        let hasSession = sessions[token] != nil
        if hasSession {
            closeHandlers[token] = handler
        }
        lock.unlock()
        // Session already gone (resolved before the handler landed): close
        // immediately so the panel does not linger.
        if !hasSession {
            handler()
        }
    }

    /// Records the browser surface hosting the panel page.
    func attachSurface(token: String, surfaceId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        guard var session = sessions[token] else { return }
        session.surfaceId = surfaceId
        sessions[token] = session
    }

    /// Replaces the stored spec (and optionally title) for a live session.
    /// Returns the updated session, or nil when the panel id is unknown.
    func updateSpec(panelId: String, spec: [String: Any], title: String?) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        guard let token = tokensByPanelId[panelId], var session = sessions[token] else {
            return nil
        }
        session.spec = spec
        if let title {
            session.title = title
        }
        sessions[token] = session
        return session
    }

    // MARK: Event flow

    /// Delivers a page event. Prompt sessions are torn down by their parked
    /// `waitNext` caller; live sessions stay open (a cancel tears them down
    /// after delivery). Returns false when the token has no session.
    @discardableResult
    func deliver(token: String, event: Event) -> Bool {
        lock.lock()
        guard var session = sessions[token] else {
            lock.unlock()
            return false
        }
        if case .submitted(let value) = event {
            session.lastSubmission = value
            sessions[token] = session
        }
        let waiter: Waiter?
        if var queue = waiters[token], !queue.isEmpty {
            waiter = queue.removeFirst()
            waiters[token] = queue
        } else {
            waiter = nil
            pendingEvents[token, default: []].append(event)
        }
        waiter?.event = event
        let isLiveCancel = session.mode == .live && isCancel(event)
        lock.unlock()

        waiter?.semaphore.signal()
        if isLiveCancel {
            teardown(token: token)
        }
        return true
    }

    private func isCancel(_ event: Event) -> Bool {
        if case .cancelled = event { return true }
        return false
    }

    /// Blocks the calling thread until an event arrives or `timeout` elapses.
    /// NEVER call on the main thread. `teardownAfter` is the prompt-mode
    /// contract: the single answer ends the session.
    func waitNext(token: String, timeout: TimeInterval, teardownAfter: Bool) -> Event? {
        lock.lock()
        guard sessions[token] != nil else {
            // Live session already ended: surface any event queued before
            // teardown (a cancel racing the waiter), else nil.
            var queued = pendingEvents[token] ?? []
            let event = queued.isEmpty ? nil : queued.removeFirst()
            pendingEvents[token] = queued.isEmpty ? nil : queued
            lock.unlock()
            return event
        }
        if var queued = pendingEvents[token], !queued.isEmpty {
            let event = queued.removeFirst()
            pendingEvents[token] = queued.isEmpty ? nil : queued
            lock.unlock()
            if teardownAfter {
                teardown(token: token)
            }
            return event
        }
        let waiter = Waiter()
        waiters[token, default: []].append(waiter)
        lock.unlock()

        _ = waiter.semaphore.wait(timeout: .now() + timeout)

        lock.lock()
        let event = waiter.event
        waiters[token]?.removeAll { $0 === waiter }
        lock.unlock()

        if teardownAfter {
            teardown(token: token)
        }
        return event
    }

    // MARK: Teardown

    /// Ends a session: revokes bridge/scheme trust, wakes every parked waiter
    /// empty-handed, and runs the close handler (closing the panel split).
    func teardown(token: String) {
        lock.lock()
        guard let session = sessions.removeValue(forKey: token) else {
            lock.unlock()
            return
        }
        tokensByPanelId[session.panelId] = nil
        let parked = waiters.removeValue(forKey: token) ?? []
        pendingEvents[token] = nil
        let closeHandler = closeHandlers.removeValue(forKey: token)
        lock.unlock()

        for waiter in parked {
            waiter.semaphore.signal()
        }
        closeHandler?()
    }

    func teardown(panelId: String) -> Bool {
        lock.lock()
        let token = tokensByPanelId[panelId]
        lock.unlock()
        guard let token else { return false }
        teardown(token: token)
        return true
    }

    /// Tears down a session that never reached a waiter (open failure).
    func discardSession(token: String) {
        teardown(token: token)
    }
}
