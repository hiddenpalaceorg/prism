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
    let identicalContent: [SimilarNeighbor]
    let sharedFiles: [SimilarNeighbor]
    let similarChunks: [SimilarNeighbor]
    let exeImports: [SimilarNeighbor]
    let exeSimilar: [SimilarNeighbor]
    let audioNeighbors: [SimilarNeighbor]
    let textNeighbors: [SimilarNeighbor]

    private enum CodingKeys: String, CodingKey {
        case query
        case identicalContent = "identical_content"
        case sharedFiles = "shared_files"
        case similarChunks = "similar_chunks"
        case exeImports = "exe_imports"
        case exeSimilar = "exe_similar"
        case audioNeighbors = "audio_neighbors"
        case textNeighbors = "text_neighbors"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = try c.decode(Query.self, forKey: .query)
        func list(_ key: CodingKeys) -> [SimilarNeighbor] {
            (try? c.decode([SimilarNeighbor].self, forKey: key)) ?? []
        }
        identicalContent = list(.identicalContent)
        sharedFiles = list(.sharedFiles)
        similarChunks = list(.similarChunks)
        exeImports = list(.exeImports)
        exeSimilar = list(.exeSimilar)
        audioNeighbors = list(.audioNeighbors)
        textNeighbors = list(.textNeighbors)
    }

    /// (section title, neighbors) for non-empty tiers, in display order.
    var sections: [(String, [SimilarNeighbor])] {
        [
            ("Identical content", identicalContent),
            ("Shared files", sharedFiles),
            ("Similar chunks", similarChunks),
            ("Same boot imports", exeImports),
            ("Similar executable", exeSimilar),
            ("Shared audio tracks", audioNeighbors),
            ("Semantically related (text)", textNeighbors),
        ].filter { !$0.1.isEmpty }
    }

    var isEmpty: Bool { sections.isEmpty }
}

/// Read-only client for the Curator web service. Base URL from `CURATOR_WEB_URL`
/// (default `http://localhost:3001`, the dev port).
struct CuratorService {
    /// The dev default, built once without a force-unwrap.
    static let defaultBaseURL: URL = {
        var c = URLComponents()
        c.scheme = "http"
        c.host = "localhost"
        c.port = 3001
        return c.url ?? URL(fileURLWithPath: "/")
    }()
    let baseURL: URL

    init() {
        let raw = ProcessInfo.processInfo.environment["CURATOR_WEB_URL"] ?? "http://localhost:3001"
        baseURL = URL(string: raw) ?? CuratorService.defaultBaseURL
    }

    enum ServiceError: LocalizedError {
        case http(Int, String)
        case offline(String)
        case timedOut(String)
        case cancelled
        case transport(String, String)
        var errorDescription: String? {
            switch self {
            case let .http(code, msg): return "Server error \(code): \(msg)"
            case let .offline(msg): return "Cannot reach \(msg). Is the web service running?"
            case let .timedOut(msg): return "Request to \(msg) timed out. Is the web service responding?"
            case .cancelled: return "Request was cancelled."
            case let .transport(msg, detail): return "Network error talking to \(msg): \(detail)"
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
        } catch let urlError as URLError {
            let host = baseURL.absoluteString
            switch urlError.code {
            case .timedOut:
                throw ServiceError.timedOut(host)
            case .cancelled:
                throw ServiceError.cancelled
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .dnsLookupFailed:
                throw ServiceError.offline(host)
            default:
                throw ServiceError.transport(host, urlError.localizedDescription)
            }
        } catch {
            throw ServiceError.transport(baseURL.absoluteString, error.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw ServiceError.http(code, msg)
        }
        return data
    }
}
