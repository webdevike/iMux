import Foundation

enum AgentSessionRendererKind: String, CaseIterable, Codable, Identifiable, Sendable {
    case react
    case solid

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .react:
            return String(localized: "agentSession.renderer.react", defaultValue: "React")
        case .solid:
            return String(localized: "agentSession.renderer.solid", defaultValue: "Solid")
        }
    }

    var resourceHTMLPathComponents: [String] {
        switch self {
        case .react:
            // Must stay a fully-inlined single-file shell: WKWebView loads these via
            // file:// where documents get an opaque origin, so ES-module shells like
            // markdown-viewer/webviews-app (script type="module" + chunk imports)
            // silently fail to load.
            return ["agent-session-react", "index.html"]
        case .solid:
            return ["agent-session-solid", "index.html"]
        }
    }
}
