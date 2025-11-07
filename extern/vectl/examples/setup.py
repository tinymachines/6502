from setuptools import setup, Extension, find_packages
import pybind11
import os
import sys

# Define the extension module
ext_modules = [
    Extension(
        'vector_store._vector_store',
        sources=[
            'src/python_bindings.cpp',
            'src/vector_cluster_store.cpp',
            'src/kmeans_clustering.cpp',
        ],
        include_dirs=[
            pybind11.get_include(),
            'src'
        ],
        language='c++',
        extra_compile_args=['-std=c++17', '-O3'],
    ),
]

setup(
    name='vector-store',
    version='0.1.0',
    author='Your Name',
    author_email='your.email@example.com',
    description='Optimized vector embedding storage on raw block devices',
    long_description=open('README.md').read() if os.path.exists('README.md') else '',
    long_description_content_type='text/markdown',
    ext_modules=ext_modules,
    install_requires=['numpy', 'pybind11>=2.6.0'],
    python_requires='>=3.6',
    zip_safe=False,
    packages=find_packages()
)
