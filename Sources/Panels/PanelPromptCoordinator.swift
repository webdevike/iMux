import Foundation

/// Parks `panel.prompt` socket-worker calls until the panel page submits,
/// cancels, or the wait times out — the FeedCoordinator waiter model applied
/// to interactive panels.
///
/// Lifecycle: the RPC registers a session (token → title/spec) BEFORE opening
/// the browser split so the scheme handler and bridge can trust-gate the very
/// first page load, then blocks its socket-worker thread in `wait(token:)`.
/// The JS bridge resolves the waiter via `resolve(token:outcome:)` when the
/// user submits or cancels; `wait` returning (either resolved or timed out)
/// tears the session down, which invalidates both file serving and bridge
/// calls for that token.
final class PanelPromptCoordinator: @unchecked Sendable {
    static let shared = PanelPromptCoordinator()

    enum Outcome {
        /// JSON-safe object posted by `panel.submit` (`params.value`).
        case submitted(Any)
        case cancelled
    }

    struct Session {
        let token: String
        let title: String
        /// Decoded JSON object handed to the page via `panel.init`.
        let spec: [String: Any]
        let createdAt: Date
    }

    private final class Waiter {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Outcome?
    }

    private let lock = NSLock()
    private var sessions: [String: Session] = [:]
    private var waiters: [String: Waiter] = [:]
    /// Registered after the browser split opens; run on resolve so the panel
    /// closes itself once its answer is delivered.
    private var closeHandlers: [String: @Sendable () -> Void] = [:]

    func register(token: String, title: String, spec: [String: Any], now: Date = Date()) {
        lock.lock()
        sessions[token] = Session(token: token, title: title, spec: spec, createdAt: now)
        lock.unlock()
    }

    func session(token: String) -> Session? {
        lock.lock()
        defer { lock.unlock() }
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
        // Session already gone (resolved/timed out before the handler landed):
        // close immediately so the panel does not linger.
        if !hasSession {
            handler()
        }
    }

    /// Tears down a session that never reached `wait` (open failure).
    func discardSession(token: String) {
        lock.lock()
        sessions[token] = nil
        waiters[token] = nil
        let closeHandler = closeHandlers.removeValue(forKey: token)
        lock.unlock()
        closeHandler?()
    }

    /// Blocks the calling thread until the panel resolves or `timeout` elapses,
    /// then tears down the session. NEVER call on the main thread — this is a
    /// socket-worker bridge, same contract as `socketAwaitCallback`.
    func wait(token: String, timeout: TimeInterval) -> Outcome? {
        let waiter = Waiter()
        lock.lock()
        // A resolve can only arrive after the page loads, which requires the
        // session registered by `register`; installing the waiter before the
        // split opens means no submit can race past us.
        waiters[token] = waiter
        lock.unlock()

        _ = waiter.semaphore.wait(timeout: .now() + timeout)

        lock.lock()
        let outcome = waiter.outcome
        waiters[token] = nil
        sessions[token] = nil
        let closeHandler = closeHandlers.removeValue(forKey: token)
        lock.unlock()

        closeHandler?()
        return outcome
    }

    /// Delivers the page's answer. Returns false when the token has no pending
    /// waiter (already resolved, timed out, or never registered).
    @discardableResult
    func resolve(token: String, outcome: Outcome) -> Bool {
        lock.lock()
        guard let waiter = waiters[token], waiter.outcome == nil else {
            lock.unlock()
            return false
        }
        waiter.outcome = outcome
        lock.unlock()
        waiter.semaphore.signal()
        return true
    }
}
