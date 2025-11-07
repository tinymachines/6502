#ifndef LOGGER_H
#define LOGGER_H

#include <string>
#include <fstream>
#include <iostream>
#include <chrono>
#include <iomanip>
#include <sstream>

class Logger {
public:
    Logger(const std::string& filename) : filename_(filename) {
        file_.open(filename, std::ios::out | std::ios::app);
    }
    
    ~Logger() {
        if (file_.is_open()) {
            file_.close();
        }
    }
    
    void debug(const std::string& message) {
        log("DEBUG", message);
    }
    
    void info(const std::string& message) {
        log("INFO", message);
    }
    
    void warning(const std::string& message) {
        log("WARNING", message);
    }
    
    void error(const std::string& message) {
        log("ERROR", message);
    }
    
private:
    std::string filename_;
    std::ofstream file_;
    
    void log(const std::string& level, const std::string& message) {
        std::string timestamp = getCurrentTimestamp();
        std::string log_entry = timestamp + " [" + level + "] " + message;
        
        if (file_.is_open()) {
            file_ << log_entry << std::endl;
        }
        
        std::cout << log_entry << std::endl;
    }
    
    std::string getCurrentTimestamp() {
        auto now = std::chrono::system_clock::now();
        auto now_c = std::chrono::system_clock::to_time_t(now);
        auto now_tm = std::localtime(&now_c);
        
        std::stringstream ss;
        ss << std::put_time(now_tm, "%Y-%m-%d %H:%M:%S");
        return ss.str();
    }
};

#endif // LOGGER_H
