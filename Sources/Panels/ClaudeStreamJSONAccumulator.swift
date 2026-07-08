import Foundation

struct ClaudeStreamJSONAccumulator {
    private static let maxTrackedMessages = 16

    private var emittedCharacterCountByMessageID: [String: Int] = [:]
    private var messageIDOrder: [String] = []
    private var currentMessageID: String?
    private var pendingDeltaCharacterCount = 0
    private var emittedAnyAssistantText = false

    var retainedTextCharacterCountForTesting: Int {
        0
    }

    mutating func consumeLine(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }
        let object = Self.unwrappingStreamEventEnvelope(parsed)

        if let messageID = assistantMessageID(fromMessageStart: object) {
            rememberMessageID(messageID)
            currentMessageID = messageID
            pendingDeltaCharacterCount = 0
            return []
        }

        if let delta = assistantTextDelta(from: object), !delta.isEmpty {
            emittedAnyAssistantText = true
            if let currentMessageID {
                rememberMessageID(currentMessageID)
                emittedCharacterCountByMessageID[currentMessageID, default: 0] += delta.count
            } else {
                pendingDeltaCharacterCount += delta.count
            }
            return [delta]
        }

        if !emittedAnyAssistantText,
           object["type"] as? String == "result",
           let result = object["result"] as? String,
           !result.isEmpty {
            emittedAnyAssistantText = true
            resetTurnTracking()
            return [result]
        }

        if Self.completesAssistantTurn(from: object) {
            resetTurnTracking()
        }
        return []
    }

    static func completesAssistantTurn(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = unwrappingStreamEventEnvelope(parsed)["type"] as? String else {
            return false
        }

        return completesAssistantTurn(type: type)
    }

    /// `claude -p --include-partial-messages` wraps every SSE-style streaming line as
    /// `{"type":"stream_event","event":{...}}`; the payload types this accumulator
    /// matches on (`message_start`, `content_block_delta`, `message_stop`) live one
    /// level down in `event`.
    private static func unwrappingStreamEventEnvelope(_ object: [String: Any]) -> [String: Any] {
        guard object["type"] as? String == "stream_event",
              let inner = object["event"] as? [String: Any] else {
            return object
        }
        return inner
    }

    private static func completesAssistantTurn(from object: [String: Any]) -> Bool {
        guard let type = object["type"] as? String else { return false }
        return completesAssistantTurn(type: type)
    }

    private static func completesAssistantTurn(type: String) -> Bool {
        switch type {
        case "result", "message_stop", "done":
            return true
        default:
            return false
        }
    }

    private func assistantMessageID(fromMessageStart object: [String: Any]) -> String? {
        guard object["type"] as? String == "message_start",
              let message = object["message"] as? [String: Any],
              message["role"] as? String == "assistant",
              let messageID = message["id"] as? String,
              !messageID.isEmpty else {
            return nil
        }
        return messageID
    }

    private mutating func assistantTextDelta(from object: [String: Any]) -> String? {
        if object["type"] as? String == "content_block_delta",
           let delta = object["delta"] as? [String: Any],
           let text = delta["text"] as? String {
            return text
        }

        guard object["type"] as? String == "assistant" else {
            return nil
        }
        let message = (object["message"] as? [String: Any]) ?? object
        let fullText = Self.contentText(from: message["content"])
        guard !fullText.isEmpty else { return nil }

        let messageID = (message["id"] as? String) ?? "assistant"
        rememberMessageID(messageID)
        let previousCharacterCount = emittedCharacterCountByMessageID[messageID] ??
            min(pendingDeltaCharacterCount, fullText.count)
        emittedCharacterCountByMessageID[messageID] = fullText.count
        if currentMessageID == messageID {
            currentMessageID = nil
        }
        pendingDeltaCharacterCount = 0
        if previousCharacterCount > 0, fullText.count >= previousCharacterCount {
            return String(fullText.dropFirst(previousCharacterCount))
        }
        return fullText
    }

    private mutating func rememberMessageID(_ messageID: String) {
        if !messageIDOrder.contains(messageID) {
            messageIDOrder.append(messageID)
        }
        while messageIDOrder.count > Self.maxTrackedMessages {
            let removed = messageIDOrder.removeFirst()
            emittedCharacterCountByMessageID.removeValue(forKey: removed)
        }
    }

    private mutating func resetTurnTracking() {
        emittedCharacterCountByMessageID.removeAll(keepingCapacity: true)
        messageIDOrder.removeAll(keepingCapacity: true)
        currentMessageID = nil
        pendingDeltaCharacterCount = 0
    }

    private static func contentText(from content: Any?) -> String {
        if let text = content as? String {
            return text
        }
        if let part = content as? [String: Any] {
            if let type = part["type"] as? String,
               type != "text" {
                return ""
            }
            return part["text"] as? String ?? ""
        }
        if let parts = content as? [Any] {
            return parts.map(contentText(from:)).joined()
        }
        return ""
    }
}

