import Foundation
import WebKit

/// Serves the bundled interactive-panel web app (`Resources/panel-web/index.html`,
/// a fully inlined single-file React shell) at `cmux-panel://<token>/index.html`.
///
/// Unlike the diff viewer's allowlist-of-temp-files model, panels serve exactly
/// one app-bundle resource; the per-request token only proves an active
/// `PanelPromptCoordinator` session, which also trust-gates `PanelPromptBridge`
/// calls from the loaded page. Once the session resolves, requests for the
/// token fail and the page cannot re-load.
final class PanelPromptURLSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "cmux-panel"
    static let shared = PanelPromptURLSchemeHandler()

    /// Same token grammar as the diff viewer (16-80 chars, alphanumerics + `-`),
    /// duplicated locally so these helpers stay callable off the main actor
    /// (the WKURLSchemeHandler conformance infers @MainActor on this type).
    nonisolated static func isValidToken(_ token: String) -> Bool {
        guard (16...80).contains(token.count) else { return false }
        return token.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "-"
        }
    }

    nonisolated static func panelURL(token: String) -> URL? {
        guard isValidToken(token) else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = token
        components.path = "/index.html"
        return components.url
    }

    /// Extracts the session token from a panel page URL; nil for anything that
    /// is not exactly `cmux-panel://<valid-token>/index.html`.
    nonisolated static func token(from url: URL?) -> String? {
        guard let url,
              url.scheme == scheme,
              let host = url.host,
              url.query == nil,
              url.fragment == nil,
              url.path == "/index.html",
              isValidToken(host) else {
            return nil
        }
        return host
    }

    private let lock = NSLock()
    private var cachedIndexHTML: Data?

    private func indexHTMLData() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        if let cachedIndexHTML {
            return cachedIndexHTML
        }
        guard let resourceURL = Bundle.main.resourceURL?
            .appendingPathComponent("panel-web/index.html", isDirectory: false),
            let data = try? Data(contentsOf: resourceURL) else {
            return nil
        }
        cachedIndexHTML = data
        return data
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              let token = Self.token(from: requestURL),
              PanelPromptCoordinator.shared.hasActiveSession(token: token),
              let data = indexHTMLData() else {
            urlSchemeTask.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": String(data.count),
                "Cache-Control": "no-store",
                // The shell is fully inlined; nothing external may load.
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:"
            ]
        ) ?? URLResponse(
            url: requestURL,
            mimeType: "text/html",
            expectedContentLength: data.count,
            textEncodingName: "utf-8"
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
