require('dotenv').config();

const express = require("express");
const db = require("./mongo");
const app = express();


// Utility: Get database connection
const getDatabase = async () => {
    return await db();
};

// Utility: Send JSON response
const sendJson = (res, data) => {
    res.json(data);
};

// GET block by height or hash
const getBlockByHeight = async (req, res) => {
    const database = await getDatabase();
    const Blocks = database.collection("blocks");
    const param = req.params.height;
    let block;
    if (!isNaN(param)) {
        block = await Blocks.findOne({ height: Number(param) });
    } else {
        block = await Blocks.findOne({ hash: param });
    }
    sendJson(res, block || {});
};

const getBlockByHeightObj = async (height) => {
    const database = await getDatabase();
    const Blocks = await database.collection("blocks");

    let block = await Blocks.findOne({ height: Number(height) });

    return block;
};

// GET tx by txid
const getTransactionByTxid = async (req, res) => {
    const database = await getDatabase();
    const Txs = database.collection("txs");
    const tx = await Txs.findOne({ txid: req.params.txid });
    sendJson(res, tx || {});
};

// GET paginated address txs
const getAddressTransactions = async (req, res) => {
    const database = await getDatabase();
    const Addr = database.collection("address_txs");
    const page = Number(req.query.page || 1);
    const limit = 50;
    const txs = await Addr.find({ address: req.params.address })
        .sort({ block_height: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();
    sendJson(res, { page, txs });
};

// GET UTXOs for address
const getUTXOsByAddress = async (req, res) => {
    const database = await getDatabase();
    const UTXO = database.collection("utxo");
    const utxos = await UTXO.find({ address: req.params.address }).toArray();
    sendJson(res, utxos);
};

// GET latest block
const getLatestBlock = async (req, res) => {
    const database = await getDatabase();
    const Blocks = database.collection("blocks");
    const latest = await Blocks.find({})
        .sort({ height: -1 })
        .limit(1)
        .toArray();
    sendJson(res, latest[0] || {});
};

// GET latest N blocks (default 20)
const getLatestBlocks = async (req, res) => {
    const db      = await getDatabase();
    const blocksC = db.collection('blocks');

    // ---- 1️⃣  Normalise the parameters -----------------------------
    let limit  = parseInt(req.query.limit, 10) || 20;
    if (limit > 500) limit = 500;
    if (limit < 1)   limit = 1;

    // Either use offset or page; offset wins if supplied
    let offset = 0;
    if (req.query.offset !== undefined) {
        offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    } else {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        offset = (page - 1) * limit;
    }

    // ---- 2️⃣  Execute the two queries in parallel ---------------
    const [blocks, total] = await Promise.all([
        blocksC.find({})
            .sort({ height: -1 })     // newest first
            .skip(offset)
            .limit(limit)
            .toArray(),

        blocksC.countDocuments()
    ]);

    // ---- 3️⃣  Build the response ---------------------------------
    const totalPages = Math.ceil(total / limit);

    const response = {
        page:    (req.query.page !== undefined) ? Math.max(1, parseInt(req.query.page, 10)) : null,
        limit:   limit,
        offset:  offset,
        total:   total,
        totalPages: totalPages,
        blocks:  blocks
    };

    // Optional: cache‑control header so a browser can keep the result for 30 s
    //res.set('Cache-Control', 'public, max-age=30');
    res.json(response);
};

// GET transactions by block height or hash
const getTransactionsByBlockHeightOrHash = async (req, res) => {
    const database = await getDatabase();
    const Txs = database.collection("txs");
    const param = req.params.height;
    let blockHeight;
    if (!isNaN(param)) {
        blockHeight = Number(param);
    } else {
        const Blocks = database.collection("blocks");
        const block = await Blocks.findOne({ hash: param });
        if (!block) {
            return sendJson(res, { block_height: null, txs: [] });
        }
        blockHeight = block.height;
    }
    const txs = await Txs.find({ block_height: blockHeight }).toArray();
    sendJson(res, { block_height: blockHeight, txs });
};

// GET transactions by block height or hash
const getTransactionsByBlockHeightOrHashObject = async (blockheight) => {
    const database = await getDatabase();
    const Txs = database.collection("txs");

    const txs = await Txs.find({ block_height: blockheight }).toArray();

    return txs;

};

// GET block by hash
const getBlockByHash = async (req, res) => {
    const database = await getDatabase();
    const Blocks = database.collection("blocks");
    const block = await Blocks.findOne({ hash: req.params.hash });
    sendJson(res, block || {});
};

// GET current explorer height (latest block height)
const getExplorerHeight = async (req, res) => {
    const database = await getDatabase();
    const Blocks = database.collection("blocks");
    const latest = await Blocks.find({})
        .sort({ height: -1 })
        .limit(1)
        .toArray();
    const height = latest[0]?.height ?? 0;
    sendJson(res, { height });
};

// 🔍 Universal Search Endpoint
app.get("/api/search", async (req, res) => {
    const database = await getDatabase();
    const Blocks = database.collection("blocks");
    const Txs = database.collection("txs");
    const Addr = database.collection("address_txs");
    const UTXO = database.collection("utxo");

    const query = req.query.q;

    if (!query) {
        return sendJson(res, { error: "Query parameter 'q' is required." });
    }

    // Try to find block by height
    if (!isNaN(query)) {
        const block = await Blocks.findOne({ height: Number(query) });
        if (block) {
            return sendJson(res, { type: "block", data: block });
        }
    }

    // Try to find block by hash
    const blockByHash = await Blocks.findOne({ hash: query });
    if (blockByHash) {
        return sendJson(res, { type: "block", data: blockByHash });
    }

    // Try to find transaction by txid
    const tx = await Txs.findOne({ txid: query });
    if (tx) {
        return sendJson(res, { type: "tx", data: tx });
    }

    // Try to find address transactions
    const addrTx = await Addr.findOne({ address: query });
    if (addrTx) {
        const txs = await Addr.find({ address: query })
            .sort({ block_height: -1 })
            .limit(10)
            .toArray();
        return sendJson(res, { type: "address", data: { address: query, txs } });
    }

    // Try to find UTXOs by address
    const utxos = await UTXO.find({ address: query }).toArray();
    if (utxos.length > 0) {
        return sendJson(res, { type: "utxo", data: utxos });
    }

    // No match found
    sendJson(res, { error: "No matching data found." });
});

// Example for CureCoin rich list
async function generateCureCoinRichList() {
    const db = await getDatabase();
    const utxoCollection = await db.collection('utxo');
    // Aggregate UTXOs by address to get balances
    const richList = await utxoCollection.aggregate([
        {
            $group: {
                _id: "$address",
                balance: { $sum: "$value" },
                utxoCount: { $sum: 1 }
            }
        },
        {
            $sort: { balance: -1 }
        },
        {
            $limit: 100
        }
    ]).toArray();

    for(let rich of richList) {//normalize variables for human readability rather than mongodb
        rich.address = rich._id;
        delete rich._id;
    }

    return richList;
}

const getRichList = async (req, res) => {
    let richlist = await generateCureCoinRichList();

    sendJson(res, richlist);
};

const Supply = require("./supply.js")
const qr = require("qrcode");

const getSupply = async (req, res) => {
    const cacheKey = 'supplyData';
    const cacheTimeout = 30 * 1000; //30s

    // Check cache
    const cached = cache[cacheKey];
    if (cached && Date.now() - cached.timestamp < cacheTimeout) {
        return sendJson(res, cached.data);
    }

    // Fetch fresh data
    let supply = await Supply();

    // Update cache
    cache[cacheKey] = {
        data: supply,
        timestamp: Date.now()
    };

    sendJson(res, supply);
};

// GET /api/address/:address/txs/count
const getAddressTxCount = async (req, res) => {
    try {
        const db      = await getDatabase();          // connection pool
        const collection = db.collection('address_txs');
        await db.collection('address_txs')
            .createIndex({ address: 1 }, { background: true });
        // 1️⃣  Ask Mongo for the number of documents that match the address
        const count = await collection.countDocuments({
            address: req.params.address
        });

        // 2️⃣  Return the number (or the whole page‑count if you like)
        sendJson(res, { count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'internal error' });
    }
};

const { Buffer } = require('buffer');

function decodeBase64(base64Str) {
    // The simplest, safest way to decode a Base‑64 string
    // Node will throw if the input is malformed
    return Buffer.from(base64Str, 'base64');
}


// Generate QR code for payment address (HMAC authenticated)
app.get("/api/qr/:address", async (req, res) => {
    try {
        const { address } = req.params;
        if (!address) {
            return sendJson(res, { error: "Address parameter is required" });
        }
        // Create QR code content in the format: curecoin:address
        const qrContent = `curecoin:${address}`;
        // Generate QR code as data URL
        const qrDataUrl = await qr.toDataURL(qrContent, {
            width: 300,
            margin: 1,
            errorCorrectionLevel: 'M'
        });

        res.send(qrDataUrl);

    } catch (error) {
        console.error('Error generating QR code:', error);
        sendJson(res, { error: "Failed to generate QR code" });
    }
});

const balanceAtHeight = async (address, height) => {
    const db = await getDatabase();
    const coll = db.collection('address_txs');

    const result = await coll.aggregate([
        { $match: { address, block_height: { $lte: height } } },

        // Helper: turn “receive” → +1, “send” → –1
        {
            $addFields: {
                signedValue: {
                    $cond: [
                        { $eq: ["$type", "receive"] },  // if receive
                        "$value",                       // keep positive
                        { $multiply: ["$value", -1] }    // otherwise subtract
                    ]
                }
            }
        },

        // 4️⃣  Sum the signed values
        {
            $group: {
                _id: null,
                balance: { $sum: "$signedValue" }
            }
        }
    ]).toArray();

    // No documents found → balance is 0
    return result[0] ? result[0].balance : 0;
};

/**
 * GET /api/address/:address/balance/:height
 *
 * Returns the balance of an address *at* (or *before*) a particular block height.
 */
const getAddressBalanceAtHeight = async (req, res) => {
    const { address, height } = req.params;

    // ---------- 1️⃣  Validate ----------
    if (!address || Number.isNaN(Number(height)) || Number(height) < 0) {
        return sendJson(res, { error: "Invalid address or block height" });
    }
    const targetHeight = Number(height);

    try {
        const bal = await balanceAtHeight(address, targetHeight);

        // MongoDB returns Decimal128 if you use it; otherwise a plain Number.
        // Convert to string to keep the response JSON‑friendly.
        const balanceStr =
            bal instanceof require('mongodb').Decimal128 ? bal.toString() : String(bal);

        sendJson(res, { address, height: targetHeight, balance: balanceStr });
    } catch (err) {
        console.error("Balance query error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

const cache = {};

app.get("/api/address/:address/balance/:height", getAddressBalanceAtHeight);
// Register routes
app.get("/api/block/:height", getBlockByHeight);
app.get("/api/tx/:txid", getTransactionByTxid);
app.get("/api/address/:address", getAddressTransactions);
app.get("/api/utxo/:address", getUTXOsByAddress);
app.get("/api/blocks/latest", getLatestBlock);
app.get("/api/blocks", getLatestBlocks);
app.get("/api/block/:height/txs", getTransactionsByBlockHeightOrHash);
app.get("/api/block/hash/:hash", getBlockByHash);
app.get("/api/blocks/height", getExplorerHeight);
app.get("/api/richlist", getRichList);
app.get("/api/supply", getSupply);
app.get("/api/address/:address/txs/count", getAddressTxCount);

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));