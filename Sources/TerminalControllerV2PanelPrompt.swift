import Foundation

// MARK: - panel.* (socket-worker lane)

extension TerminalController {
    /// `panel.prompt` — one-shot: registers a prompt session, opens the panel
    /// split, then parks the socket worker until the page submits, cancels, or
    /// `timeout_seconds` elapses. The panel closes when the wait ends.
    ///
    /// Result: `{status: "submitted"|"cancelled"|"timeout", value?, …refs}`.
    nonisolated func v2PanelPromptOnSocketWorker(params: [String: Any]) -> V2CallResult {
        switch panelOpenSession(params: params, mode: .prompt) {
        case .failure(let error):
            return error
        case .success(let opened):
            let event = PanelPromptCoordinator.shared.waitNext(
                token: opened.token,
                timeout: TimeInterval(opened.timeoutSeconds),
                teardownAfter: true
            )
            var payload = opened.refsPayload
            switch event {
            case .submitted(let value)?:
                payload["status"] = "submitted"
                payload["value"] = value
            case .cancelled?:
                payload["status"] = "cancelled"
            case nil:
                payload["status"] = "timeout"
            }
            return .ok(payload)
        }
    }

    /// `panel.open` — live: registers a session and opens the split, returning
    /// immediately with the panel id. Pair with `panel.wait` / `panel.update` /
    /// `panel.read` / `panel.close`.
    nonisolated func v2PanelOpenOnSocketWorker(params: [String: Any]) -> V2CallResult {
        switch panelOpenSession(params: params, mode: .live) {
        case .failure(let error):
            return error
        case .success(let opened):
            var payload = opened.refsPayload
            payload["panel_id"] = opened.panelId
            payload["status"] = "open"
            return .ok(payload)
        }
    }

    /// `panel.wait` — live: blocks until the panel's next submit/cancel or
    /// `timeout_seconds`. Result mirrors `panel.prompt` plus `panel_id`; a
    /// cancel means the session ended (the panel closed itself).
    nonisolated func v2PanelWaitOnSocketWorker(params: [String: Any]) -> V2CallResult {
        guard let panelId = Self.panelParamString(params, "panel_id") else {
            return .err(code: "invalid_params", message: "panel.wait requires panel_id", data: nil)
        }
        guard let session = PanelPromptCoordinator.shared.session(panelId: panelId) else {
            return .err(code: "not_found", message: "No open panel with id '\(panelId)'", data: nil)
        }
        let requestedTimeout = Self.panelParamInt(params, "timeout_seconds") ?? 3600
        guard (1...86400).contains(requestedTimeout) else {
            return .err(code: "invalid_params", message: "timeout_seconds must be between 1 and 86400", data: nil)
        }
        let event = PanelPromptCoordinator.shared.waitNext(
            token: session.token,
            timeout: TimeInterval(requestedTimeout),
            teardownAfter: false
        )
        var payload: [String: Any] = ["panel_id": panelId]
        switch event {
        case .submitted(let value)?:
            payload["status"] = "submitted"
            payload["value"] = value
        case .cancelled?:
            payload["status"] = "cancelled"
        case nil:
            payload["status"] = "timeout"
        }
        return .ok(payload)
    }

    /// `panel.update` — live: replaces the session's spec (and optionally
    /// title) and pushes it into the running page via `window.__cmuxPanelApply`.
    nonisolated func v2PanelUpdateOnSocketWorker(params: [String: Any]) -> V2CallResult {
        guard let panelId = Self.panelParamString(params, "panel_id") else {
            return .err(code: "invalid_params", message: "panel.update requires panel_id", data: nil)
        }
        guard let spec = params["spec"] as? [String: Any], JSONSerialization.isValidJSONObject(spec) else {
            return .err(code: "invalid_params", message: "panel.update requires a JSON-serializable `spec` object", data: nil)
        }
        let title = Self.panelParamString(params, "title")
        guard let session = PanelPromptCoordinator.shared.updateSpec(panelId: panelId, spec: spec, title: title) else {
            return .err(code: "not_found", message: "No open panel with id '\(panelId)'", data: nil)
        }

        var applyPayload: [String: Any] = ["spec": spec]
        applyPayload["title"] = session.title
        guard let payloadData = try? JSONSerialization.data(withJSONObject: applyPayload),
              let payloadJSON = String(data: payloadData, encoding: .utf8) else {
            return .err(code: "internal_error", message: "Failed to encode spec", data: nil)
        }
        guard let surfaceId = session.surfaceId else {
            return .err(code: "internal_error", message: "Panel surface not tracked", data: nil)
        }
        let script = "window.__cmuxPanelApply(\(payloadJSON)) === true"
        let evalResult = v2BrowserEval(params: [
            "surface_id": surfaceId.uuidString,
            "script": script
        ])
        switch evalResult {
        case .err(let code, let message, _):
            return .err(code: code, message: "Panel page did not accept the update: \(message)", data: nil)
        case .ok(let payloadAny):
            let applied = ((payloadAny as? [String: Any])?["value"] as? Bool) ?? false
            guard applied else {
                return .err(code: "panel_apply_failed", message: "window.__cmuxPanelApply did not return true", data: nil)
            }
            return .ok(["panel_id": panelId, "status": "updated"])
        }
    }

    /// `panel.read` — live: last submitted value (or null) without blocking.
    nonisolated func v2PanelReadOnSocketWorker(params: [String: Any]) -> V2CallResult {
        guard let panelId = Self.panelParamString(params, "panel_id") else {
            return .err(code: "invalid_params", message: "panel.read requires panel_id", data: nil)
        }
        guard let session = PanelPromptCoordinator.shared.session(panelId: panelId) else {
            return .err(code: "not_found", message: "No open panel with id '\(panelId)'", data: nil)
        }
        return .ok([
            "panel_id": panelId,
            "title": session.title,
            "mode": session.mode.rawValue,
            "value": session.lastSubmission ?? NSNull()
        ])
    }

    /// `panel.close` — live: ends the session and closes the panel split.
    nonisolated func v2PanelCloseOnSocketWorker(params: [String: Any]) -> V2CallResult {
        guard let panelId = Self.panelParamString(params, "panel_id") else {
            return .err(code: "invalid_params", message: "panel.close requires panel_id", data: nil)
        }
        guard PanelPromptCoordinator.shared.teardown(panelId: panelId) else {
            return .err(code: "not_found", message: "No open panel with id '\(panelId)'", data: nil)
        }
        return .ok(["panel_id": panelId, "status": "closed"])
    }

    // MARK: Shared open path

    private enum PanelOpenOutcome {
        case success(PanelOpened)
        case failure(V2CallResult)
    }

    private struct PanelOpened {
        let token: String
        let panelId: String
        let timeoutSeconds: Int
        let refsPayload: [String: Any]
    }

    private nonisolated func panelOpenSession(
        params: [String: Any],
        mode: PanelPromptCoordinator.Mode
    ) -> PanelOpenOutcome {
        guard let spec = params["spec"] as? [String: Any] else {
            return .failure(.err(code: "invalid_params", message: "panel requires a `spec` object", data: nil))
        }
        guard JSONSerialization.isValidJSONObject(spec) else {
            return .failure(.err(code: "invalid_params", message: "panel `spec` must be JSON-serializable", data: nil))
        }
        let title = Self.panelParamString(params, "title")
            ?? (spec["title"] as? String)
            ?? "Panel"
        let requestedTimeout = Self.panelParamInt(params, "timeout_seconds") ?? 3600
        guard (1...86400).contains(requestedTimeout) else {
            return .failure(.err(code: "invalid_params", message: "timeout_seconds must be between 1 and 86400", data: nil))
        }

        let token = "panel-" + UUID().uuidString.lowercased()
        let panelId: String
        if let requested = Self.panelParamString(params, "panel_id") {
            guard Self.isValidPanelId(requested) else {
                return .failure(.err(
                    code: "invalid_params",
                    message: "panel_id must be 1-64 chars of letters, digits, '-', '_', '.'",
                    data: nil
                ))
            }
            panelId = requested
        } else {
            panelId = String(token.dropFirst("panel-".count))
        }
        guard let url = PanelPromptURLSchemeHandler.panelURL(token: token) else {
            return .failure(.err(code: "internal_error", message: "Failed to build panel URL", data: nil))
        }
        // Register before opening so the scheme handler and bridge trust the
        // page's very first load.
        guard PanelPromptCoordinator.shared.register(
            token: token,
            panelId: panelId,
            title: title,
            spec: spec,
            mode: mode
        ) else {
            return .failure(.err(code: "conflict", message: "A panel with id '\(panelId)' is already open", data: nil))
        }

        var openParams: [String: Any] = [
            "url": url.absoluteString,
            "show_omnibar": false,
            "bypass_remote_proxy": true
        ]
        for key in ["workspace_id", "surface_id", "window_id", "focus"] {
            if let value = params[key] {
                openParams[key] = value
            }
        }

        let openResult: V2CallResult? = socketAwaitCallback(timeout: 15) { complete in
            Task { @MainActor [weak self] in
                guard let self else {
                    complete(V2CallResult.err(code: "internal_error", message: "Controller unavailable", data: nil))
                    return
                }
                complete(self.v2BrowserOpenSplit(params: openParams))
            }
        }
        guard let openResult else {
            PanelPromptCoordinator.shared.discardSession(token: token)
            return .failure(.err(code: "timeout", message: "Timed out opening panel split", data: nil))
        }
        guard case .ok(let openPayloadAny) = openResult, let openPayload = openPayloadAny as? [String: Any] else {
            PanelPromptCoordinator.shared.discardSession(token: token)
            return .failure(openResult)
        }

        if let workspaceIdString = openPayload["workspace_id"] as? String,
           let surfaceIdString = openPayload["surface_id"] as? String,
           let workspaceId = UUID(uuidString: workspaceIdString),
           let surfaceId = UUID(uuidString: surfaceIdString) {
            PanelPromptCoordinator.shared.attachSurface(token: token, surfaceId: surfaceId)
            PanelPromptCoordinator.shared.setCloseHandler(token: token) {
                Task { @MainActor in
                    guard let match = AppDelegate.shared?.workspaceContainingPanel(
                        panelId: surfaceId,
                        preferredWorkspaceId: workspaceId
                    ) else { return }
                    _ = TerminalController.shared.closeSurfaceRecordingHistory(
                        in: match.workspace,
                        surfaceId: surfaceId,
                        force: true
                    )
                }
            }
        }

        var refsPayload: [String: Any] = [:]
        for key in ["workspace_id", "workspace_ref", "surface_id", "surface_ref"] {
            refsPayload[key] = openPayload[key] ?? NSNull()
        }
        return .success(PanelOpened(
            token: token,
            panelId: panelId,
            timeoutSeconds: requestedTimeout,
            refsPayload: refsPayload
        ))
    }

    // MARK: Param helpers

    private nonisolated static func isValidPanelId(_ id: String) -> Bool {
        guard (1...64).contains(id.count) else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_" || scalar == "."
        }
    }

    private nonisolated static func panelParamString(_ params: [String: Any], _ key: String) -> String? {
        guard let raw = params[key] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private nonisolated static func panelParamInt(_ params: [String: Any], _ key: String) -> Int? {
        if let intValue = params[key] as? Int {
            return intValue
        }
        if let number = params[key] as? NSNumber {
            return number.intValue
        }
        if let raw = panelParamString(params, key) {
            return Int(raw)
        }
        return nil
    }
}
