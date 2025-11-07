#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include "vector_cluster_store.h"
#include "logger.h"
#include <iostream>

namespace py = pybind11;

PYBIND11_MODULE(vector_cluster_store_py, m) {
    m.doc() = "Vector cluster storage for embeddings on raw devices";
    
    py::class_<Logger>(m, "Logger")
        .def(py::init<const std::string&>());
    
    py::class_<VectorClusterStore>(m, "VectorClusterStore")
        .def(py::init<Logger&>())
        .def("initialize", &VectorClusterStore::initialize)
        .def("store_vector", [](VectorClusterStore& self, uint32_t id, const std::vector<float>& vec, const std::string& metadata = "") {
            std::cout << "Python binding: store_vector called with id=" << id 
                      << ", vector size=" << vec.size() << std::endl;
            
            // Verify the vector is not empty
            if (vec.empty()) {
                std::cerr << "Error: Empty vector passed to store_vector" << std::endl;
                return false;
            }
            
            // Call the C++ method
            try {
                return self.storeVector(id, vec, metadata);
            } catch (const std::exception& e) {
                std::cerr << "C++ exception in store_vector: " << e.what() << std::endl;
                return false;
            }
        })
        .def("retrieve_vector", [](VectorClusterStore& self, uint32_t id) {
            std::cout << "Python binding: retrieve_vector called with id=" << id << std::endl;
            
            try {
                Vector vec;
                if (self.retrieveVector(id, vec)) {
                    return vec;
                } else {
                    return Vector();
                }
            } catch (const std::exception& e) {
                std::cerr << "C++ exception in retrieve_vector: " << e.what() << std::endl;
                return Vector();
            }
        })
        .def("get_vector_metadata", [](VectorClusterStore& self, uint32_t id) {
            try {
                return self.getVectorMetadata(id);
            } catch (const std::exception& e) {
                std::cerr << "C++ exception in get_vector_metadata: " << e.what() << std::endl;
                return std::string("");
            }
        })
        .def("find_similar_vectors", [](VectorClusterStore& self, const Vector& query, uint32_t k = 10) {
            std::cout << "Python binding: find_similar_vectors called with query size=" 
                      << query.size() << ", k=" << k << std::endl;
            
            try {
                return self.findSimilarVectors(query, k);
            } catch (const std::exception& e) {
                std::cerr << "C++ exception in find_similar_vectors: " << e.what() << std::endl;
                return std::vector<std::pair<uint32_t, float>>();
            }
        })
        .def("delete_vector", &VectorClusterStore::deleteVector)
        .def("perform_maintenance", &VectorClusterStore::performMaintenance)
        .def("save_index", &VectorClusterStore::saveIndex)
        .def("load_index", &VectorClusterStore::loadIndex)
        .def("print_store_info", &VectorClusterStore::printStoreInfo)
        .def("print_cluster_info", &VectorClusterStore::printClusterInfo);
}
