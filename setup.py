from setuptools import setup, find_packages

setup(
    name="6502-expert-agent",
    version="0.1.0",
    description="A 6502 Processor Expert Agent using RAG with vector search",
    author="Bisenbek",
    python_requires=">=3.6",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    install_requires=[
        "requests>=2.32.0",
        "numpy>=1.24.0",
        "python-dotenv>=1.0.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "black>=23.0.0",
        ],
    },
)
