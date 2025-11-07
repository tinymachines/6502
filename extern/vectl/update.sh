#!/bin/bash

git pull
sudo apt update
sudo apt install -y build-essential cmake libboost-all-dev python3-dev python3-pip
python -m pip install --upgrade pip
python -m pip install --upgrade numpy pybind11
python -m pip install -r requirements.txt
