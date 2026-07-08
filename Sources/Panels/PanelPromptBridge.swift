import Foundation
import WebKit

/// Native bridge for interactive panel pages. Pages served from an active
/// `cmux-panel://<token>` session call
/// `window.webkit.messageHandlers.cmuxPanel.postMessage({method, params})`
/// and receive a Promise resolving to `{ok: true, value}` or
/// `{ok: false, error: {code, userMessage}}`.
///
/// Methods:
/// - `panel.init`   → `{title, spec}` for the session
/// - `panel.submit` (`params.value`) → resolves the parked `panel.prompt` RPC
/// - `panel.cancel` → resolves the RPC with a cancelled status
///
/// Only main-frame pages whose URL carries a token with an active
/// `PanelPromptCoordinator` session may call the bridge — same trust model as
/// `DiffCommentsBridge`.
final class PanelPromptBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "cmuxPanel"
    static let shared = PanelPromptBridge()

    private static var installedKey: UInt8 = 0

    static func installIfNeeded(on controller: WKUserContentController) {
        if objc_getAssociatedObject(controller, &installedKey) != nil {
            return
        }
        controller.addScriptMessageHandler(shared, contentWorld: .page, name: handlerName)
        objc_setAssociatedObject(controller, &installedKey, true, .OBJC_ASSOCIATION_RETAIN)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame,
              let token = PanelPromptURLSchemeHandler.token(from: message.frameInfo.request.url),
              PanelPromptCoordinator.shared.hasActiveSession(token: token) else {
            replyHandler(Self.errorReply(code: "not_allowed", userMessage: "Untrusted panel frame"), nil)
            return
        }
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String else {
            replyHandler(Self.errorReply(code: "invalid_message", userMessage: "Message must be {method, params?}"), nil)
            return
        }
        let params = body["params"] as? [String: Any] ?? [:]

        switch method {
        case "panel.init":
            guard let session = PanelPromptCoordinator.shared.session(token: token) else {
                replyHandler(Self.errorReply(code: "not_allowed", userMessage: "Panel session expired"), nil)
                return
            }
            replyHandler(["ok": true, "value": ["title": session.title, "spec": session.spec]], nil)

        case "panel.submit":
            guard let value = params["value"] else {
                replyHandler(Self.errorReply(code: "invalid_message", userMessage: "panel.submit requires params.value"), nil)
                return
            }
            guard PanelPromptCoordinator.shared.resolve(token: token, outcome: .submitted(value)) else {
                replyHandler(Self.errorReply(code: "already_resolved", userMessage: "Panel already resolved"), nil)
                return
            }
            replyHandler(["ok": true, "value": [String: Any]()], nil)

        case "panel.cancel":
            guard PanelPromptCoordinator.shared.resolve(token: token, outcome: .cancelled) else {
                replyHandler(Self.errorReply(code: "already_resolved", userMessage: "Panel already resolved"), nil)
                return
            }
            replyHandler(["ok": true, "value": [String: Any]()], nil)

        default:
            replyHandler(Self.errorReply(code: "unknown_method", userMessage: "Unknown panel method: \(method)"), nil)
        }
    }

    private static func errorReply(code: String, userMessage: String) -> [String: Any] {
        ["ok": false, "error": ["code": code, "userMessage": userMessage]]
    }
}
