import Foundation

/// One neighbor returned by `/api/similarity`. Tiers share sha256/name/system and
/// carry whichever score applies (Jaccard, TLSH distance, cosine sim, shared count).
struct SimilarNeighbor: Decodable, Identifiable {
    let sha256: String
    let name: String?
    let system: String?
    let jaccard: Double?
    let distance: Double?
    let sim: Double?
    let shared: Int?
    var id: String { sha256 }

    /// Human-readable score for the tier it came from.
    var scoreText: String? {
        if let jaccard { return String(format: "%.0f%%", jaccard * 100) }
        if let sim { return String(format: "%.2f", sim) }
        if let distance { return "d=\(Int(distance))" }
        if let shared { return "\(shared) shared" }
        return nil
    }
}

/// Response of `POST /api/similarity` (arrays default to empty when a tier is absent).
struct SimilarityResponse: Decodable {
    struct Query: Decodable { let sha256: String?; let name: String? }
    let query: Query
    let tier1Twins: [SimilarNeighbor]
    let tier2: [SimilarNeighbor]
    let tier3: [SimilarNeighbor]
    let tier5Exe: [SimilarNeighbor]
    let tier5Tlsh: [SimilarNeighbor]
    let audioNeighbors: [SimilarNeighbor]
    let textNeighbors: [SimilarNeighbor]

    private enum CodingKeys: String, CodingKey {
        case query
        case tier1Twins = "tier1_twins"
        case tier2, tier3
        case tier5Exe = "tier5_exe"
        case tier5Tlsh = "tier5_tlsh"
        case audioNeighbors = "audio_neighbors"
        case textNeighbors = "text_neighbors"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = try c.decode(Query.self, forKey: .query)
        func list(_ key: CodingKeys) -> [SimilarNeighbor] {
            (try? c.decode([SimilarNeighbor].self, forKey: key)) ?? []
        }
        tier1Twins = list(.tier1Twins)
        tier2 = list(.tier2)
        tier3 = list(.tier3)
        tier5Exe = list(.tier5Exe)
        tier5Tlsh = list(.tier5Tlsh)
        audioNeighbors = list(.audioNeighbors)
        textNeighbors = list(.textNeighbors)
    }

    /// (section title, neighbors) for non-empty tiers, in display order.
    var sections: [(String, [SimilarNeighbor])] {
        [
            ("Identical content (Tier 1)", tier1Twins),
            ("Shared files (Tier 2)", tier2),
            ("Similar chunks (Tier 3)", tier3),
            ("Same boot imports (Tier 5)", tier5Exe),
            ("Similar executable (TLSH)", tier5Tlsh),
            ("Shared audio tracks", audioNeighbors),
            ("Semantically related (text)", textNeighbors),
        ].filter { !$0.1.isEmpty }
    }

    var isEmpty: Bool { sections.isEmpty }
}

/// Read-only client for the Curator web service. Base URL from `CURATOR_WEB_URL`
/// (default `http://localhost:3001`, the dev port).
struct CuratorService {
    let baseURL: URL

    init() {
        let raw = ProcessInfo.processInfo.environment["CURATOR_WEB_URL"] ?? "http://localhost:3001"
        baseURL = URL(string: raw) ?? URL(string: "http://localhost:3001")!
    }

    enum ServiceError: LocalizedError {
        case http(Int, String)
        case offline(String)
        var errorDescription: String? {
            switch self {
            case let .http(code, msg): return "Server error \(code): \(msg)"
            case let .offline(msg): return "Cannot reach \(msg). Is the web service running?"
            }
        }
    }

    /// POST the canonical record JSON to `/api/similarity`.
    func findSimilar(recordJSON: String) async throws -> SimilarityResponse {
        let data = try await post(path: "/api/similarity", body: Data(recordJSON.utf8))
        return try JSONDecoder().decode(SimilarityResponse.self, from: data)
    }

    struct SubmitResult: Decodable { let sha256: String; let status: String }

    /// POST `{ nickname, record }` to `/api/submissions`.
    func submit(recordJSON: String, nickname: String) async throws -> SubmitResult {
        let record = try JSONSerialization.jsonObject(with: Data(recordJSON.utf8))
        let payload: [String: Any] = ["nickname": nickname, "record": record]
        let body = try JSONSerialization.data(withJSONObject: payload)
        let data = try await post(path: "/api/submissions", body: body)
        return try JSONDecoder().decode(SubmitResult.self, from: data)
    }

    private func post(path: String, body: Data) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw ServiceError.offline(baseURL.absoluteString)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw ServiceError.http(code, msg)
        }
        return data
    }
}
