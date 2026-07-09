import AppKit
import Highlightr
import CmuxFoundation
import CmuxSettings
import SwiftUI

@MainActor
protocol FilePreviewTextEditingPanel: AnyObject {
    var textContent: String { get }
    var filePath: String { get }

    func attachTextView(_ textView: NSTextView)
    func retryPendingFocus()
    func updateTextContent(_ nextContent: String)
    @discardableResult
    func saveTextContent() -> Task<Void, Never>?
}

struct FilePreviewTextEditor<PanelModel>: NSViewRepresentable where PanelModel: ObservableObject & FilePreviewTextEditingPanel {
    @ObservedObject var panel: PanelModel
    let isVisibleInUI: Bool
    let themeBackgroundColor: NSColor
    let themeForegroundColor: NSColor
    let drawsBackground: Bool
    /// Whether long lines soft-wrap at the editor's right edge. Sourced from
    /// the persisted `fileEditor.wordWrap` setting; updates apply live.
    let wordWrap: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(panel: panel)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.isHidden = !isVisibleInUI
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = drawsBackground

        let textView = SavingTextView.makeFilePreviewTextView()
        textView.panel = panel
        textView.delegate = context.coordinator
        textView.drawsBackground = drawsBackground
        textView.string = panel.textContent
        panel.attachTextView(textView)

        scrollView.documentView = textView
        textView.applyFilePreviewWordWrap(wordWrap, scrollView: scrollView)
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true
        scrollView.verticalRulerView = FilePreviewLineNumberRulerView(textView: textView, scrollView: scrollView)
        Self.applyTheme(
            to: scrollView,
            backgroundColor: themeBackgroundColor,
            foregroundColor: themeForegroundColor,
            drawsBackground: drawsBackground
        )
        textView.applyFilePreviewSyntaxHighlight(
            fileURL: URL(fileURLWithPath: panel.filePath),
            isDark: FilePreviewSyntaxHighlighter.isDark(foregroundColor: themeForegroundColor),
            fallbackColor: themeForegroundColor
        )
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.panel = panel
        scrollView.isHidden = !isVisibleInUI
        Self.applyTheme(
            to: scrollView,
            backgroundColor: themeBackgroundColor,
            foregroundColor: themeForegroundColor,
            drawsBackground: drawsBackground
        )
        guard let textView = scrollView.documentView as? SavingTextView else { return }
        textView.panel = panel
        textView.applyFilePreviewTextEditorInsets()
        textView.applyFilePreviewWordWrap(wordWrap, scrollView: scrollView)
        panel.attachTextView(textView)
        if textView.string != panel.textContent {
            context.coordinator.isApplyingPanelUpdate = true
            textView.string = panel.textContent
            context.coordinator.isApplyingPanelUpdate = false
        }
        textView.applyFilePreviewSyntaxHighlight(
            fileURL: URL(fileURLWithPath: panel.filePath),
            isDark: FilePreviewSyntaxHighlighter.isDark(foregroundColor: themeForegroundColor),
            fallbackColor: themeForegroundColor
        )
    }

    static func applyTheme(
        to scrollView: NSScrollView,
        backgroundColor: NSColor,
        foregroundColor: NSColor,
        drawsBackground: Bool
    ) {
        let resolvedBackgroundColor = drawsBackground ? backgroundColor : .clear
        scrollView.drawsBackground = drawsBackground
        scrollView.backgroundColor = resolvedBackgroundColor
        scrollView.contentView.drawsBackground = drawsBackground
        scrollView.contentView.backgroundColor = resolvedBackgroundColor
        if let textView = scrollView.documentView as? NSTextView {
            textView.drawsBackground = drawsBackground
            textView.backgroundColor = resolvedBackgroundColor
            textView.textColor = foregroundColor
            textView.insertionPointColor = foregroundColor
        }
        let isDark = FilePreviewSyntaxHighlighter.isDark(foregroundColor: foregroundColor)
        if let savingTextView = scrollView.documentView as? SavingTextView {
            savingTextView.applyEditorChromeTheme(isDark: isDark)
        }
        if let ruler = scrollView.verticalRulerView as? FilePreviewLineNumberRulerView {
            ruler.gutterTextColor = foregroundColor.withAlphaComponent(0.45)
            ruler.gutterBackgroundColor = resolvedBackgroundColor
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var panel: PanelModel
        var isApplyingPanelUpdate = false

        init(panel: PanelModel) {
            self.panel = panel
        }

        deinit {}

        func textDidChange(_ notification: Notification) {
            guard !isApplyingPanelUpdate,
                  let textView = notification.object as? NSTextView else { return }
            panel.updateTextContent(textView.string)
        }
    }
}

enum FilePreviewTextEditorLayout {
    static let textContainerInset = NSSize(width: 12, height: 10)
    static let lineFragmentPadding: CGFloat = 0
}

fileprivate struct FilePreviewSyntaxHighlightSignature: Equatable {
    let contentHash: Int
    let isDark: Bool
}

fileprivate struct FilePreviewSyntaxHighlightRun {
    let range: NSRange
    let color: NSColor
}

/// Produces per-range foreground colors for the File Preview text editor using
/// Highlightr (highlight.js via JavaScriptCore). Only foreground colors are
/// emitted; font/size stays owned by the editor's zoom machinery, so applying a
/// run set never fights `applyCurrentPreviewFont()`.
fileprivate enum FilePreviewSyntaxHighlighter {
    /// Files longer than this are left unhighlighted. Highlightr tokenizes the
    /// whole document synchronously and the editor re-highlights on content
    /// change, so cap well below the editor's 16 MB text ceiling to keep load
    /// and per-keystroke recompute responsive on large files.
    static let maximumHighlightableLength = 120_000

    private static let highlightr: Highlightr? = Highlightr()

    /// Light foreground text implies a dark theme background.
    static func isDark(foregroundColor: NSColor) -> Bool {
        foregroundColor.markdownOpaqueSRGB.isLightColor
    }

    static func colorRuns(for text: String, fileURL: URL, isDark: Bool) -> [FilePreviewSyntaxHighlightRun]? {
        guard !text.isEmpty, text.utf16.count <= maximumHighlightableLength else { return nil }
        guard let language = language(for: fileURL), let highlightr else { return nil }
        highlightr.setTheme(to: isDark ? "atom-one-dark" : "atom-one-light")
        guard let highlighted = highlightr.highlight(text, as: language, fastRender: true) else { return nil }
        var runs: [FilePreviewSyntaxHighlightRun] = []
        highlighted.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: highlighted.length)
        ) { value, range, _ in
            guard let color = value as? NSColor else { return }
            runs.append(FilePreviewSyntaxHighlightRun(range: range, color: color))
        }
        return runs
    }

    /// Maps a file to a highlight.js language name, or nil when unknown so the
    /// caller leaves the file as plain text.
    static func language(for url: URL) -> String? {
        let ext = url.pathExtension.lowercased()
        if !ext.isEmpty, let mapped = extensionLanguageMap[ext] { return mapped }
        return filenameLanguageMap[url.lastPathComponent.lowercased()]
    }

    private static let extensionLanguageMap: [String: String] = [
        "swift": "swift",
        "m": "objectivec", "mm": "objectivec", "h": "objectivec", "hpp": "cpp",
        "c": "c", "cc": "cpp", "cpp": "cpp", "cxx": "cpp",
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
        "ts": "typescript", "tsx": "typescript",
        "py": "python", "pyi": "python",
        "rb": "ruby", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin", "kts": "kotlin",
        "cs": "csharp", "php": "php", "scala": "scala", "swiftinterface": "swift",
        "sh": "bash", "bash": "bash", "zsh": "bash", "fish": "bash",
        "json": "json", "jsonc": "json",
        "yml": "yaml", "yaml": "yaml", "toml": "ini", "ini": "ini", "cfg": "ini", "conf": "ini",
        "xml": "xml", "plist": "xml", "svg": "xml", "html": "xml", "htm": "xml",
        "css": "css", "scss": "scss", "sass": "scss", "less": "less",
        "sql": "sql", "graphql": "graphql", "gql": "graphql",
        "md": "markdown", "markdown": "markdown", "mdx": "markdown",
        "dockerfile": "dockerfile", "make": "makefile", "mk": "makefile",
        "lua": "lua", "pl": "perl", "pm": "perl", "r": "r", "dart": "dart",
        "ex": "elixir", "exs": "elixir", "erl": "erlang", "clj": "clojure",
        "hs": "haskell", "vim": "vim", "diff": "diff", "patch": "diff",
        "gradle": "gradle", "groovy": "groovy", "proto": "protobuf",
        "tf": "terraform", "hcl": "terraform", "env": "bash",
    ]

    private static let filenameLanguageMap: [String: String] = [
        "dockerfile": "dockerfile",
        "makefile": "makefile",
        "gnumakefile": "makefile",
        "cmakelists.txt": "cmake",
        ".gitignore": "bash",
        ".zshrc": "bash",
        ".bashrc": "bash",
        ".bash_profile": "bash",
        "package.json": "json",
        "tsconfig.json": "json",
    ]
}

extension SavingTextView {
    /// Builds the File Preview text view configured for large plain-text files.
    ///
    /// File Preview opens files up to `FilePreviewPanel.maximumLoadedTextBytes` (16 MB), which can
    /// be hundreds of thousands of lines. Selection responsiveness on that content is the reason
    /// this configuration is centralized; see `manaflow-ai/cmux#4576`.
    static func makeFilePreviewTextView() -> SavingTextView {
        // Build an EXPLICIT TextKit 1 stack so this view is never TextKit 2.
        //
        // A default `NSTextView()` is TextKit 2: selection/hit-testing then runs through
        // `NSTextSelectionNavigation`, whose work is O(N) in line-fragment count, so clicking or
        // drag-selecting in a large document pegs the main thread inside AppKit's modal
        // mouse-tracking loop and freezes the whole app (`manaflow-ai/cmux#4576`, `#5255`).
        //
        // Merely *reading* `.layoutManager` afterward — the previous mitigation — only drops the
        // view to TextKit 2 *compatibility* mode: `textLayoutManager` stays non-nil and the slow
        // selection path remains active (confirmed by live `sample` captures of the hung process).
        // Constructing the view from an `NSTextStorage` / `NSLayoutManager` / `NSTextContainer`
        // stack is the only way to guarantee `textLayoutManager == nil`, i.e. a pure TextKit 1 view
        // whose hit-testing uses `NSLayoutManager` (O(log N) with non-contiguous layout).
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        // Lazy glyph layout so multi-hundred-thousand-line documents still open instantly.
        layoutManager.allowsNonContiguousLayout = true
        textStorage.addLayoutManager(layoutManager)
        let textContainer = NSTextContainer(
            size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        )
        // No-wrap baseline; `applyFilePreviewWordWrap(_:scrollView:)` flips this live per the
        // `fileEditor.wordWrap` setting.
        textContainer.widthTracksTextView = false
        layoutManager.addTextContainer(textContainer)

        let textView = SavingTextView(frame: .zero, textContainer: textContainer)
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true
        textView.usesFontPanel = false
        textView.applyCurrentPreviewFont()
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.autoresizingMask = [.width]
        textView.applyFilePreviewTextEditorInsets()
        return textView
    }
}

extension NSTextView {
    /// Configures the text view and its scroll view for soft line wrapping
    /// (`wrap == true`) or the no-wrap baseline with a horizontal scroller
    /// (`wrap == false`). Idempotent, so it is safe to call on every SwiftUI
    /// update; toggling the `fileEditor.wordWrap` setting reflows open editors.
    func applyFilePreviewWordWrap(_ wrap: Bool, scrollView: NSScrollView) {
        guard let textContainer else { return }
        scrollView.hasHorizontalScroller = !wrap
        isHorizontallyResizable = !wrap
        if wrap {
            textContainer.widthTracksTextView = true
            // `widthTracksTextView` keeps the container pinned to the text view
            // width, so wrapping is correct even before the scroll view is laid
            // out. Only snap the frame/container to a real measured width to
            // avoid collapsing to a zero-width container during `makeNSView`,
            // before the clip view has a size; `updateNSView` re-runs once laid
            // out and reflows.
            let visibleWidth = scrollView.contentSize.width
            if visibleWidth > 0 {
                textContainer.size = NSSize(width: visibleWidth, height: .greatestFiniteMagnitude)
                setFrameSize(NSSize(width: visibleWidth, height: frame.height))
            }
        } else {
            textContainer.widthTracksTextView = false
            textContainer.size = NSSize(
                width: CGFloat.greatestFiniteMagnitude,
                height: CGFloat.greatestFiniteMagnitude
            )
        }
    }

    func applyFilePreviewTextEditorInsets() {
        let targetInset = FilePreviewTextEditorLayout.textContainerInset
        if textContainerInset.width != targetInset.width || textContainerInset.height != targetInset.height {
            textContainerInset = targetInset
        }
        if textContainer?.lineFragmentPadding != FilePreviewTextEditorLayout.lineFragmentPadding {
            textContainer?.lineFragmentPadding = FilePreviewTextEditorLayout.lineFragmentPadding
        }
    }
}

final class SavingTextView: NSTextView {
    private static let defaultPreviewFontSize: CGFloat = 13
    private static let minimumPreviewFontSize: CGFloat = 8
    private static let maximumPreviewFontSize: CGFloat = 36
    private static let previewFontZoomShortcutActions: [KeyboardShortcutSettings.Action] = [
        .browserZoomIn,
        .browserZoomOut,
        .browserZoomReset,
    ]

    weak var panel: (any FilePreviewTextEditingPanel)?
    private var previewFontSize: CGFloat = 13
    private var pendingEditorShortcutChordPrefix: ShortcutStroke?
    private var fontMagnificationObserver: GlobalFontMagnificationChangeObserver?
    private var highlightSignature: FilePreviewSyntaxHighlightSignature?
    private var cachedHighlightRuns: [FilePreviewSyntaxHighlightRun]?
    private var currentLineHighlightColor: NSColor?
    private var bracketMatchColor: NSColor = NSColor.systemGray.withAlphaComponent(0.3)
    private var bracketHighlightRanges: [NSRange] = []

    convenience init() {
        self.init(frame: .zero, textContainer: nil)
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        installFontMagnificationObserver()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        installFontMagnificationObserver()
    }

    deinit {}

    private func installFontMagnificationObserver() {
        fontMagnificationObserver = GlobalFontMagnificationChangeObserver { [weak self] in
            self?.applyCurrentPreviewFont()
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        clearPendingShortcutChordPrefixes()
        applyFilePreviewTextEditorInsets()
        panel?.retryPendingFocus()
    }

    override func resignFirstResponder() -> Bool {
        let didResign = super.resignFirstResponder()
        if didResign {
            clearPendingShortcutChordPrefixes()
        }
        return didResign
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown else {
            return super.performKeyEquivalent(with: event)
        }
        if handleEditorShortcut(event) {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func magnify(with event: NSEvent) {
        let factor = 1.0 + event.magnification
        guard factor.isFinite, factor > 0 else { return }
        adjustPreviewFontSize(by: factor)
    }

    override func scrollWheel(with event: NSEvent) {
        guard FilePreviewInteraction.hasZoomModifier(event) else {
            super.scrollWheel(with: event)
            return
        }
        adjustPreviewFontSize(by: FilePreviewInteraction.zoomFactor(forScroll: event))
    }

    override func smartMagnify(with event: NSEvent) {
        if previewFontSize == Self.defaultPreviewFontSize {
            _ = setPreviewFontSize(18)
        } else {
            _ = resetPreviewFontSize()
        }
    }

    @discardableResult
    func zoomPreviewFontIn() -> Bool {
        adjustPreviewFontSize(by: FilePreviewInteraction.zoomStep)
    }

    @discardableResult
    func zoomPreviewFontOut() -> Bool {
        adjustPreviewFontSize(by: 1 / FilePreviewInteraction.zoomStep)
    }

    @discardableResult
    func resetPreviewFontSize() -> Bool {
        setPreviewFontSize(Self.defaultPreviewFontSize)
    }

    @discardableResult
    private func adjustPreviewFontSize(by factor: CGFloat) -> Bool {
        setPreviewFontSize(previewFontSize * factor)
    }

    @discardableResult
    private func setPreviewFontSize(_ nextFontSize: CGFloat) -> Bool {
        let clamped = min(max(nextFontSize, Self.minimumPreviewFontSize), Self.maximumPreviewFontSize)
        guard clamped.isFinite else { return false }
        guard abs(clamped - previewFontSize) > 0.0001 else { return false }
        previewFontSize = clamped
        applyCurrentPreviewFont()
        return true
    }

    func applyCurrentPreviewFont() {
        let nextFont = GlobalFontMagnification.monospacedSystemFont(ofSize: previewFontSize, weight: .regular)
        font = nextFont
        typingAttributes[.font] = nextFont
    }

    // MARK: Editor chrome — current-line highlight + bracket matching

    /// Sets the current-line and bracket-match overlay colors for the active
    /// theme and re-applies the bracket highlight. Colors are overlays drawn
    /// (current line) or applied as temporary attributes (brackets), so they
    /// never touch text storage and cannot fight the syntax-highlight runs or
    /// the `applyTheme` foreground-color reset.
    func applyEditorChromeTheme(isDark: Bool) {
        let base: NSColor = isDark ? .white : .black
        currentLineHighlightColor = base.withAlphaComponent(isDark ? 0.07 : 0.05)
        bracketMatchColor = base.withAlphaComponent(isDark ? 0.22 : 0.16)
        for range in bracketHighlightRanges {
            layoutManager?.removeTemporaryAttribute(.backgroundColor, forCharacterRange: range)
        }
        bracketHighlightRanges = []
        updateBracketMatchHighlight(stillSelecting: false)
        needsDisplay = true
    }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        guard let highlightColor = currentLineHighlightColor,
              let layoutManager, textContainer != nil else { return }
        let selection = selectedRange()
        guard selection.length == 0 else { return }
        let length = (string as NSString).length
        let caret = min(selection.location, length)
        let lineRect: NSRect
        if length == 0 || caret >= length,
           layoutManager.extraLineFragmentTextContainer != nil {
            lineRect = layoutManager.extraLineFragmentRect
        } else {
            let glyphIndex = layoutManager.glyphIndexForCharacter(at: caret)
            lineRect = layoutManager.lineFragmentRect(forGlyphAt: min(glyphIndex, max(0, layoutManager.numberOfGlyphs - 1)), effectiveRange: nil)
        }
        guard !lineRect.isEmpty else { return }
        let origin = textContainerOrigin
        let fullWidth = NSRect(x: 0, y: lineRect.minY + origin.y, width: bounds.width, height: lineRect.height)
        guard fullWidth.intersects(rect) else { return }
        highlightColor.setFill()
        fullWidth.fill()
    }

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting stillSelectingFlag: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelectingFlag)
        updateBracketMatchHighlight(stillSelecting: stillSelectingFlag)
        needsDisplay = true
    }

    private func updateBracketMatchHighlight(stillSelecting: Bool) {
        guard let layoutManager else { return }
        for range in bracketHighlightRanges {
            layoutManager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: range)
        }
        bracketHighlightRanges = []
        guard !stillSelecting else { return }
        let selection = selectedRange()
        guard selection.length == 0 else { return }
        let text = string as NSString
        let length = text.length
        guard let (bracketIndex, isOpen) = adjacentBracket(in: text, caret: selection.location, length: length),
              let matchIndex = matchingBracketIndex(in: text, from: bracketIndex, isOpen: isOpen, length: length) else { return }
        let ranges = [NSRange(location: bracketIndex, length: 1), NSRange(location: matchIndex, length: 1)]
        for range in ranges {
            layoutManager.addTemporaryAttribute(.backgroundColor, value: bracketMatchColor, forCharacterRange: range)
        }
        bracketHighlightRanges = ranges
    }

    private func adjacentBracket(in text: NSString, caret: Int, length: Int) -> (index: Int, isOpen: Bool)? {
        if caret > 0, let open = Self.bracketIsOpen(text.character(at: caret - 1)) {
            return (caret - 1, open)
        }
        if caret < length, let open = Self.bracketIsOpen(text.character(at: caret)) {
            return (caret, open)
        }
        return nil
    }

    private static func bracketIsOpen(_ c: unichar) -> Bool? {
        switch c {
        case 0x28, 0x5B, 0x7B: return true   // ( [ {
        case 0x29, 0x5D, 0x7D: return false  // ) ] }
        default: return nil
        }
    }

    private static func matchingBracket(_ c: unichar) -> unichar {
        switch c {
        case 0x28: return 0x29
        case 0x29: return 0x28
        case 0x5B: return 0x5D
        case 0x5D: return 0x5B
        case 0x7B: return 0x7D
        case 0x7D: return 0x7B
        default: return c
        }
    }

    /// Scans outward from a bracket for its balanced partner, capped so an
    /// unbalanced huge document can never turn a keystroke into an O(N) scan.
    private func matchingBracketIndex(in text: NSString, from index: Int, isOpen: Bool, length: Int) -> Int? {
        let maxScan = 50_000
        let bracket = text.character(at: index)
        let partner = Self.matchingBracket(bracket)
        var depth = 0
        var scanned = 0
        var i = index
        while scanned < maxScan {
            if isOpen {
                guard i < length else { return nil }
            } else {
                guard i >= 0 else { return nil }
            }
            let c = text.character(at: i)
            if c == bracket {
                depth += 1
            } else if c == partner {
                depth -= 1
                if depth == 0 { return i }
            }
            i += isOpen ? 1 : -1
            scanned += 1
        }
        return nil
    }

    /// Applies syntax-highlight foreground colors over the current text. Recomputes
    /// only when the content or theme changes (cached otherwise), because the
    /// editor's `applyTheme` resets `textColor` on every SwiftUI update and would
    /// otherwise wipe the coloring. Unknown languages and oversized files are
    /// left as the fallback (already-applied) plain color.
    func applyFilePreviewSyntaxHighlight(fileURL: URL, isDark: Bool, fallbackColor: NSColor) {
        guard let textStorage else { return }
        let content = string
        let signature = FilePreviewSyntaxHighlightSignature(contentHash: content.hashValue, isDark: isDark)
        if highlightSignature != signature {
            highlightSignature = signature
            cachedHighlightRuns = FilePreviewSyntaxHighlighter.colorRuns(
                for: content,
                fileURL: fileURL,
                isDark: isDark
            )
        }
        guard let runs = cachedHighlightRuns, !runs.isEmpty else { return }
        let length = textStorage.length
        textStorage.beginEditing()
        for run in runs where NSMaxRange(run.range) <= length {
            textStorage.addAttribute(.foregroundColor, value: run.color, range: run.range)
        }
        textStorage.endEditing()
    }

    private func clearPendingShortcutChordPrefixes() {
        pendingEditorShortcutChordPrefix = nil
    }

    private func handleEditorShortcut(_ event: NSEvent) -> Bool {
        let candidates = editorShortcutCandidates()
        if let pendingPrefix = pendingEditorShortcutChordPrefix {
            pendingEditorShortcutChordPrefix = nil
            for candidate in candidates {
                guard candidate.shortcut.firstStroke == pendingPrefix,
                      let secondStroke = candidate.shortcut.secondStroke,
                      secondStroke.matches(event: event) else { continue }
                guard candidate.isAllowed(event) else { return false }
                candidate.perform()
                return true
            }
            return false
        }

        for candidate in candidates {
            let shortcut = candidate.shortcut
            if shortcut.secondStroke != nil {
                if shortcut.firstStroke.matches(event: event) {
                    guard candidate.isAllowed(event) else { return false }
                    pendingEditorShortcutChordPrefix = shortcut.firstStroke
                    return true
                }
                continue
            }
            if shortcut.matches(event: event) {
                guard candidate.isAllowed(event) else { return false }
                candidate.perform()
                return true
            }
        }
        return false
    }

    private func editorShortcutCandidates() -> [
        (shortcut: StoredShortcut, isAllowed: (NSEvent) -> Bool, perform: () -> Void)
    ] {
        var candidates: [(shortcut: StoredShortcut, isAllowed: (NSEvent) -> Bool, perform: () -> Void)] = []
        let saveShortcut = KeyboardShortcutSettings.shortcut(for: .saveFilePreview)
        if !saveShortcut.isUnbound {
            candidates.append((saveShortcut, { _ in true }, { [weak self] in self?.panel?.saveTextContent() }))
        }
        for action in Self.previewFontZoomShortcutActions {
            let shortcut = KeyboardShortcutSettings.shortcut(for: action)
            guard !shortcut.isUnbound else { continue }
            candidates.append((
                shortcut,
                { [weak self] event in
                    self?.previewFontZoomShortcutWhenClauseAllows(action: action, event: event) ?? false
                },
                { [weak self] in self?.performPreviewFontZoomShortcutAction(action) }
            ))
        }
        return candidates
    }

    private func previewFontZoomShortcutWhenClauseAllows(
        action: KeyboardShortcutSettings.Action,
        event: NSEvent
    ) -> Bool {
        if window != nil, let appDelegate = AppDelegate.shared {
            return appDelegate.shortcutWhenClauseAllows(action: action, event: event)
        }
        return KeyboardShortcutSettings.effectiveWhenClause(for: action)
            .evaluate(Self.filePreviewTextEditorShortcutContext)
    }

    private static var filePreviewTextEditorShortcutContext: ShortcutContext {
        ShortcutFocusState(
            browser: false,
            markdown: false,
            sidebar: false,
            filePreviewTextEditor: true
        ).context
    }

    private func performPreviewFontZoomShortcutAction(_ action: KeyboardShortcutSettings.Action) {
        switch action {
        case .browserZoomIn:
            _ = zoomPreviewFontIn()
        case .browserZoomOut:
            _ = zoomPreviewFontOut()
        case .browserZoomReset:
            _ = resetPreviewFontSize()
        default:
            break
        }
    }
}

extension FilePreviewPanel {
    func attachTextView(_ textView: NSTextView) {
        self.textView = textView
        focusCoordinator.register(root: textView, primaryResponder: textView, intent: .textEditor)
    }

    @discardableResult
    func zoomTextPreviewIn() -> Bool {
        guard previewMode == .text,
              let textView = textView as? SavingTextView else { return false }
        return textView.zoomPreviewFontIn()
    }

    @discardableResult
    func zoomTextPreviewOut() -> Bool {
        guard previewMode == .text,
              let textView = textView as? SavingTextView else { return false }
        return textView.zoomPreviewFontOut()
    }

    @discardableResult
    func resetTextPreviewZoom() -> Bool {
        guard previewMode == .text,
              let textView = textView as? SavingTextView else { return false }
        return textView.resetPreviewFontSize()
    }
}

/// Left-margin line-number gutter for the File Preview editor.
///
/// Line-start character offsets are rebuilt only when the text changes
/// (`NSText.didChangeNotification`), never per scroll/redraw, so drawing stays
/// O(visible lines). Documents past `maxGutterableLength` collapse the gutter
/// to zero width rather than paying the O(N) index build on every keystroke —
/// preserving the 16 MB large-file path the editor is tuned for.
final class FilePreviewLineNumberRulerView: NSRulerView {
    private static let maxGutterableLength = 2_000_000
    private static let horizontalPadding: CGFloat = 8

    private weak var editorTextView: NSTextView?
    private var lineStartIndices: [Int] = [0]
    private var lineIndexDirty = true

    var gutterTextColor: NSColor = .secondaryLabelColor { didSet { needsDisplay = true } }
    var gutterBackgroundColor: NSColor = .clear { didSet { needsDisplay = true } }

    init(textView: NSTextView, scrollView: NSScrollView) {
        editorTextView = textView
        super.init(scrollView: scrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 44
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleTextChange), name: NSText.didChangeNotification, object: textView)
        center.addObserver(self, selector: #selector(handleBoundsChange), name: NSView.frameDidChangeNotification, object: textView)
        if let clip = scrollView.contentView as NSClipView? {
            clip.postsBoundsChangedNotifications = true
            center.addObserver(self, selector: #selector(handleBoundsChange), name: NSView.boundsDidChangeNotification, object: clip)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func handleTextChange() { lineIndexDirty = true; needsDisplay = true }
    @objc private func handleBoundsChange() { needsDisplay = true }

    private var gutterFont: NSFont {
        let base = editorTextView?.font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        return NSFont.monospacedSystemFont(ofSize: max(9, base.pointSize - 2), weight: .regular)
    }

    private func rebuildLineIndexIfNeeded(_ text: NSString) {
        guard lineIndexDirty else { return }
        lineIndexDirty = false
        guard text.length <= Self.maxGutterableLength else {
            lineStartIndices = []
            updateThickness(lineCount: 0)
            return
        }
        var starts: [Int] = [0]
        text.enumerateSubstrings(in: NSRange(location: 0, length: text.length),
                                 options: [.byLines, .substringNotRequired]) { _, _, enclosingRange, _ in
            let next = enclosingRange.location + enclosingRange.length
            if next < text.length { starts.append(next) }
        }
        lineStartIndices = starts
        updateThickness(lineCount: starts.count)
    }

    private func updateThickness(lineCount: Int) {
        guard lineCount > 0 else {
            if ruleThickness != 0 { ruleThickness = 0 }
            return
        }
        let digits = max(2, String(lineCount).count)
        let sample = String(repeating: "8", count: digits) as NSString
        let width = ceil(sample.size(withAttributes: [.font: gutterFont]).width) + Self.horizontalPadding * 2
        if abs(ruleThickness - width) > 0.5 { ruleThickness = width }
    }

    /// 1-based line number for a character index: count of line starts <= index.
    private func lineNumber(forCharIndex charIndex: Int) -> Int {
        var lo = 0, hi = lineStartIndices.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if lineStartIndices[mid] <= charIndex { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    private func isLineStart(_ charIndex: Int) -> Bool {
        var lo = 0, hi = lineStartIndices.count
        while lo < hi {
            let mid = (lo + hi) / 2
            let v = lineStartIndices[mid]
            if v == charIndex { return true }
            if v < charIndex { lo = mid + 1 } else { hi = mid }
        }
        return false
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView = editorTextView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return }
        let text = textView.string as NSString
        rebuildLineIndexIfNeeded(text)

        gutterBackgroundColor.setFill()
        rect.fill()
        guard !lineStartIndices.isEmpty else { return }

        let attributes: [NSAttributedString.Key: Any] = [.font: gutterFont, .foregroundColor: gutterTextColor]
        let relativeY = convert(NSPoint.zero, from: textView).y
        let insetY = textView.textContainerInset.height
        let visibleGlyphRange = layoutManager.glyphRange(forBoundingRect: textView.visibleRect, in: textContainer)

        layoutManager.enumerateLineFragments(forGlyphRange: visibleGlyphRange) { fragmentRect, _, _, glyphRange, _ in
            let charIndex = layoutManager.characterIndexForGlyph(at: glyphRange.location)
            guard self.isLineStart(charIndex) else { return }
            self.drawNumber(self.lineNumber(forCharIndex: charIndex),
                            atFragmentY: fragmentRect.minY, height: fragmentRect.height,
                            relativeY: relativeY, insetY: insetY, attributes: attributes)
        }

        // Trailing empty line (document empty, or ends in a newline): the extra
        // line fragment that `enumerateLineFragments` does not report.
        if text.length == 0 {
            let extra = layoutManager.extraLineFragmentRect
            if !extra.isEmpty {
                drawNumber(1, atFragmentY: extra.minY, height: extra.height,
                           relativeY: relativeY, insetY: insetY, attributes: attributes)
            }
        } else if text.character(at: text.length - 1) == 0x0A {
            let extra = layoutManager.extraLineFragmentRect
            if !extra.isEmpty {
                drawNumber(lineStartIndices.count + 1, atFragmentY: extra.minY, height: extra.height,
                           relativeY: relativeY, insetY: insetY, attributes: attributes)
            }
        }
    }

    private func drawNumber(_ number: Int, atFragmentY fragmentY: CGFloat, height: CGFloat,
                            relativeY: CGFloat, insetY: CGFloat,
                            attributes: [NSAttributedString.Key: Any]) {
        let label = String(number) as NSString
        let size = label.size(withAttributes: attributes)
        let y = relativeY + fragmentY + insetY + (height - size.height) / 2
        let x = ruleThickness - size.width - Self.horizontalPadding
        label.draw(at: NSPoint(x: x, y: y), withAttributes: attributes)
    }
}
