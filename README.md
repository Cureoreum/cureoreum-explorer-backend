# Cureoreum Backend

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node.js-%3E=16.0.0-brightgreen)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/mongodb-%3E=4.0.0-green)](https://www.mongodb.com/)

**Cureoreum** is a backend service for the Curecoin 2.0 blockchain explorer. It provides a robust indexing engine to synchronize with the blockchain and a RESTful API to serve block data, transaction history, address information, and analytics to frontend applications.

## 📋 Features

- **Real-time Indexing:** Continuously syncs block data, transactions, and UTXO sets from a Curecoin node.
- **RESTful API:** Comprehensive endpoints for blocks, transactions, addresses, and global statistics.
- **Address Tracking:** Tracks transaction history (sends/receives) and historical balances.
- **Rich List:** Automated generation of the top Curecoin holders.
- **Utility Tools:** QR code generation for payment addresses and universal search.
- **Fault Tolerance:** Automatic retry mechanisms and blockchain rollback support during indexing errors.

## 🏗 Architecture

The backend is composed of two main processes managed by `main.js`:

1.  **Indexer (`indexer.js`):**
    -   Connects to a local Curecoin RPC node.
    -   Validates and stores block/transaction data into MongoDB.
    -   Manages the UTXO set and address ledger.
    -   Handles chain reorganization rollbacks if necessary.
2.  **API Server (`apiserver.js`):**
    -   Exposes an Express.js web server.
    -   Queries the indexed MongoDB database.
    -   Provides caching for frequently accessed data (e.g., supply).
    -   Generates QR codes dynamically.

## 🚀 Prerequisites

Before running Cureoreum, ensure you have the following installed:

-   **Node.js** (v16.0.0 or higher)
-   **MongoDB** (v4.0.0 or higher) with a running instance
-   **Curecoin Core Daemon** (`curecoind`) running with RPC enabled
-   **Git**

## ⚙️ Installation

1.  **Clone the repository**
    ```bash
    https://github.com/Cureoreum/cureoreum-explorer-backend.git
    cd cureoreum-explorer-backend
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables**
    Create a `.env` file in the root directory. Example configuration:

    ```env
    # MongoDB Connection
    MONGODB_URI=mongodb://localhost:27017/curecoin_db
    MONGODB_DB_NAME=curecoin_db

    # Curecoin RPC Configuration
    RPC_HOST=localhost
    RPC_PORT=8333
    RPC_USER=curecoinrpc
    RPC_PASSWORD=your_rpc_password

    # API Server Port
    PORT=3001
    ```

4.  **Configure Curecoin Node**
    Ensure your `curecoin.conf` has RPC enabled and permissions match your `.env` settings:
    ```ini
    server=1
    rpcuser=curecoinrpc
    rpcpassword=your_rpc_password
    rpcallowip=127.0.0.1
    ```

    Alternatively, we supply a rpc stand in server as an option to using the standard rpc.
    https://github.com/Cureoreum/cureoreum-cure-rpc
## ▶️ Usage

### Starting the Service
The application is orchestrated via `main.js`, which spawns both the indexer and the API server.

```bash
node main.js
