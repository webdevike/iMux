import Foundation

// MARK: - panel.prompt (socket-worker lane)

extension TerminalController {
    /// `panel.prompt` — registers an interactive-panel session, opens the panel
    /// web app in a browser split of the caller's workspace, then parks the
    /// socket worker until the page submits, cancels, or `timeout_seconds`
    /// elapses. The panel closes itself when the wait ends, whatever the
    /// outcome.
    ///
    /// Params:
    /// - `spec` (object, required): UI spec handed verbatim to the page.
    /// - `title` (string, optional): panel title; falls back to `spec.title`.
    /// - `timeout_seconds` (number, optional, default 3600, max 86400).
    /// - `workspace_id` / `surface_id` / `window_id` / `focus`: same targeting
    ///   semantics as `browser.open_split`.
    ///
    /// Result: `{status: "submitted"|"cancelled"|"timeout", value?, …refs}`.
    nonisolated func v2PanelPromptOnSocketWorker(params: [String: Any]) -> V2CallResult {
        guard let spec = params["spec"] as? [String: Any] else {
            return .err(code: "invalid_params", message: "panel.prompt requires a `spec` object", data: nil)
        }
        guard JSONSerialization.isValidJSONObject(spec) else {
            return .err(code: "invalid_params", message: "panel.prompt `spec` must be JSON-serializable", data: nil)
        }
        let title = Self.panelParamString(params, "title")
            ?? (spec["title"] as? String)
            ?? "Panel"
        let requestedTimeout = Self.panelParamInt(params, "timeout_seconds") ?? 3600
        guard (1...86400).contains(requestedTimeout) else {
            return .err(code: "invalid_params", message: "timeout_seconds must be between 1 and 86400", data: nil)
        }

        let token = "panel-" + UUID().uuidString.lowercased()
        guard let url = PanelPromptURLSchemeHandler.panelURL(token: token) else {
            return .err(code: "internal_error", message: "Failed to build panel URL", data: nil)
        }
        // Register before opening so the scheme handler and bridge trust the
        // page's very first load.
        PanelPromptCoordinator.shared.register(token: token, title: title, spec: spec)

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
            return .err(code: "timeout", message: "Timed out opening panel split", data: nil)
        }
        guard case .ok(let openPayloadAny) = openResult, let openPayload = openPayloadAny as? [String: Any] else {
            PanelPromptCoordinator.shared.discardSession(token: token)
            return openResult
        }

        if let workspaceIdString = openPayload["workspace_id"] as? String,
           let surfaceIdString = openPayload["surface_id"] as? String,
           let workspaceId = UUID(uuidString: workspaceIdString),
           let surfaceId = UUID(uuidString: surfaceIdString) {
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

        let outcome = PanelPromptCoordinator.shared.wait(token: token, timeout: TimeInterval(requestedTimeout))

        var payload: [String: Any] = [:]
        for key in ["workspace_id", "workspace_ref", "surface_id", "surface_ref"] {
            payload[key] = openPayload[key] ?? NSNull()
        }
        switch outcome {
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
