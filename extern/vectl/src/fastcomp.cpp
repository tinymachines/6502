#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <curl/curl.h>
#include <json/json.h>
#include <cmath>
#include <chrono>

// Configuration constants
const std::string OLLAMA_API_URL = "http://127.0.0.1:11434/api/embed";
const std::string EMBEDDING_MODEL = "nomic-embed-text";
const int VECTOR_DIM = 768;

// Structure to hold response data from curl
struct HttpResponse {
    std::string data;
};

// Callback function to write data received from curl
static size_t WriteCallback(void* contents, size_t size, size_t nmemb, HttpResponse* response) {
    size_t totalSize = size * nmemb;
    response->data.append(static_cast<char*>(contents), totalSize);
    return totalSize;
}

// Get embedding from Ollama API
std::vector<float> getEmbedding(const std::string& text) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "Error: Failed to initialize curl" << std::endl;
        return {};
    }
    
    // Prepare JSON payload
    Json::Value payload;
    payload["model"] = EMBEDDING_MODEL;
    payload["input"] = text;
    
    Json::StreamWriterBuilder builder;
    std::string jsonPayload = Json::writeString(builder, payload);
    
    // Set up HTTP headers
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    
    HttpResponse response;
    
    // Configure curl
    curl_easy_setopt(curl, CURLOPT_URL, OLLAMA_API_URL.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonPayload.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L); // 30 second timeout
    
    // Perform the request
    CURLcode res = curl_easy_perform(curl);
    
    // Clean up
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    
    if (res != CURLE_OK) {
        std::cerr << "Error: HTTP request failed: " << curl_easy_strerror(res) << std::endl;
        return {};
    }
    
    // Parse JSON response
    Json::CharReaderBuilder readerBuilder;
    Json::Value responseJson;
    std::string errors;
    
    std::istringstream responseStream(response.data);
    if (!Json::parseFromStream(readerBuilder, responseStream, &responseJson, &errors)) {
        std::cerr << "Error: Failed to parse JSON response: " << errors << std::endl;
        return {};
    }
    
    // Extract embedding from response
    if (!responseJson.isMember("embeddings") || !responseJson["embeddings"].isArray() || 
        responseJson["embeddings"].empty()) {
        std::cerr << "Error: Invalid response format - missing embeddings" << std::endl;
        return {};
    }
    
    const Json::Value& embedding = responseJson["embeddings"][0];
    if (!embedding.isArray()) {
        std::cerr << "Error: Embedding is not an array" << std::endl;
        return {};
    }
    
    std::vector<float> result;
    result.reserve(embedding.size());
    
    for (const auto& value : embedding) {
        if (value.isNumeric()) {
            result.push_back(value.asFloat());
        } else {
            std::cerr << "Error: Non-numeric value in embedding" << std::endl;
            return {};
        }
    }
    
    // Verify dimension
    if (result.size() != VECTOR_DIM) {
        std::cerr << "Warning: Embedding dimension mismatch. Expected " << VECTOR_DIM 
                  << ", got " << result.size() << std::endl;
    }
    
    return result;
}

// Calculate cosine distance between two vectors (1 - cosine similarity)
float calculateCosineDistance(const std::vector<float>& v1, const std::vector<float>& v2) {
    if (v1.size() != v2.size()) {
        std::cerr << "Error: Vector dimension mismatch" << std::endl;
        return -1.0f;
    }
    
    float dotProduct = 0.0f;
    float norm1 = 0.0f;
    float norm2 = 0.0f;
    
    for (size_t i = 0; i < v1.size(); ++i) {
        dotProduct += v1[i] * v2[i];
        norm1 += v1[i] * v1[i];
        norm2 += v2[i] * v2[i];
    }
    
    norm1 = std::sqrt(norm1);
    norm2 = std::sqrt(norm2);
    
    if (norm1 == 0.0f || norm2 == 0.0f) {
        return 1.0f; // Maximum distance for zero vectors
    }
    
    float cosineSimilarity = dotProduct / (norm1 * norm2);
    return 1.0f - cosineSimilarity; // Convert to distance
}

// Calculate Euclidean distance between two vectors
float calculateEuclideanDistance(const std::vector<float>& v1, const std::vector<float>& v2) {
    if (v1.size() != v2.size()) {
        std::cerr << "Error: Vector dimension mismatch" << std::endl;
        return -1.0f;
    }
    
    float sumSquares = 0.0f;
    for (size_t i = 0; i < v1.size(); ++i) {
        float diff = v1[i] - v2[i];
        sumSquares += diff * diff;
    }
    
    return std::sqrt(sumSquares);
}

// Print usage information
void printUsage(const char* programName) {
    std::cout << "Usage: " << programName << " [options]" << std::endl;
    std::cout << "Fast vector comparison tool for text embeddings" << std::endl;
    std::cout << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout << "  -h, --help     Show this help message" << std::endl;
    std::cout << "  -m, --metric   Distance metric: cosine (default) or euclidean" << std::endl;
    std::cout << std::endl;
    std::cout << "Input format:" << std::endl;
    std::cout << "  Reads text from stdin, one line per text to compare" << std::endl;
    std::cout << "  First line is the basis vector (v0)" << std::endl;
    std::cout << "  Subsequent lines are compared against v0" << std::endl;
    std::cout << std::endl;
    std::cout << "Output:" << std::endl;
    std::cout << "  Prints distance values to stdout, one per line" << std::endl;
    std::cout << std::endl;
    std::cout << "Example:" << std::endl;
    std::cout << "  echo -e 'Michigan\\nDetroit\\nChicago\\nCalifornia' | " << programName << std::endl;
}

int main(int argc, char* argv[]) {
    // Parse command line arguments
    std::string metric = "cosine";
    
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else if (arg == "-m" || arg == "--metric") {
            if (i + 1 < argc) {
                metric = argv[++i];
                if (metric != "cosine" && metric != "euclidean") {
                    std::cerr << "Error: Invalid metric. Use 'cosine' or 'euclidean'" << std::endl;
                    return 1;
                }
            } else {
                std::cerr << "Error: --metric requires an argument" << std::endl;
                return 1;
            }
        } else {
            std::cerr << "Error: Unknown option: " << arg << std::endl;
            printUsage(argv[0]);
            return 1;
        }
    }
    
    // Initialize curl globally
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
        std::cerr << "Error: Failed to initialize curl" << std::endl;
        return 1;
    }
    
    // Read input lines
    std::vector<std::string> texts;
    std::string line;
    
    while (std::getline(std::cin, line)) {
        if (!line.empty()) {
            texts.push_back(line);
        }
    }
    
    if (texts.empty()) {
        std::cerr << "Error: No input text provided" << std::endl;
        curl_global_cleanup();
        return 1;
    }
    
    if (texts.size() < 2) {
        std::cerr << "Error: Need at least 2 texts to compare (basis + 1 comparison)" << std::endl;
        curl_global_cleanup();
        return 1;
    }
    
    // Get embedding for basis vector (first text)
    auto start = std::chrono::high_resolution_clock::now();
    std::vector<float> basisVector = getEmbedding(texts[0]);
    
    if (basisVector.empty()) {
        std::cerr << "Error: Failed to get embedding for basis text" << std::endl;
        curl_global_cleanup();
        return 1;
    }
    
    // Compare against each subsequent text
    std::vector<float> distances;
    
    for (size_t i = 1; i < texts.size(); ++i) {
        std::vector<float> compareVector = getEmbedding(texts[i]);
        
        if (compareVector.empty()) {
            std::cerr << "Error: Failed to get embedding for text " << i + 1 << std::endl;
            curl_global_cleanup();
            return 1;
        }
        
        float distance;
        if (metric == "cosine") {
            distance = calculateCosineDistance(basisVector, compareVector);
        } else {
            distance = calculateEuclideanDistance(basisVector, compareVector);
        }
        
        if (distance < 0) {
            std::cerr << "Error: Failed to calculate distance" << std::endl;
            curl_global_cleanup();
            return 1;
        }
        
        distances.push_back(distance);
    }
    
    auto end = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    
    // Output distances to stdout
    for (float distance : distances) {
        std::cout << distance << std::endl;
    }
    
    // Output timing info to stderr (so it doesn't interfere with piped output)
    std::cerr << "Processed " << texts.size() << " texts in " << duration.count() << "ms" << std::endl;
    
    curl_global_cleanup();
    return 0;
}