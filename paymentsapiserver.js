require('dotenv').config();


const express = require("express");
const db = require("./mongo");
const app = express();
const axios = require("axios");
const qr = require("qrcode");
const crypto = require("crypto");

// Utility: Get database connection
const getDatabase = async () => {
    return await db();
};

// Utility: Send JSON response
const sendJson = (res, data) => {
    res.json(data);
};

// HMAC Authentication Middleware
const authenticateHMAC = (req, res, next) => {
    const hmacSecret = process.env.HMAC_SECRET;
    const hmacSignature = req.headers['x-hmac-signature'];
    const hmacTimestamp = req.headers['x-hmac-timestamp'];
    const hmacNonce = req.headers['x-hmac-nonce'];

    if (!hmacSecret || !hmacSignature || !hmacTimestamp || !hmacNonce) {
        return sendJson(res, { error: "Missing required HMAC headers" });
    }

    // Check if timestamp is too old (5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const timestamp = parseInt(hmacTimestamp);
    if (Math.abs(now - timestamp) > 300) { // 5 minutes
        return sendJson(res, { error: "Request timestamp too old" });
    }

    // Create HMAC signature
    const method = req.method;
    const path = req.url;
    const body = req.body ? JSON.stringify(req.body) : '';

    const message = `${method}:${path}:${timestamp}:${hmacNonce}:${body}`;
    const expectedSignature = crypto
        .createHmac('sha256', hmacSecret)
        .update(message)
        .digest('hex');

    // Verify signature
    if (expectedSignature !== hmacSignature) {
        return sendJson(res, { error: "Invalid HMAC signature" });
    }

    next();
};

// Payment receipt system with MongoDB persistence
class PaymentReceiptSystem {
    constructor() {
        this.activePayments = new Map(); // In-memory cache for current monitoring
        this.checkInterval = 5000; // Check every 5 seconds
        this.timeout = 30 * 60 * 1000; // 30 minutes in milliseconds
        this.startMonitoring();
        this.loadActivePayments();
    }

    // Load active payments from MongoDB on startup
    async loadActivePayments() {
        try {
            const database = await getDatabase();
            const receiptsCollection = database.collection("payment_receipts");

            // Find all pending payments that haven't timed out
            const pendingReceipts = await receiptsCollection.find({
                status: "pending",
                expiresAt: { $gt: new Date() }
            }).toArray();

            console.log(`Loaded ${pendingReceipts.length} active payments from database`);

            // Load payments into memory for monitoring
            pendingReceipts.forEach(receipt => {
                this.activePayments.set(receipt.address, receipt);
            });
        } catch (error) {
            console.error('Error loading active payments:', error);
        }
    }

    // Start monitoring payments
    startMonitoring() {
        setInterval(async () => {
            await this.checkActivePayments();
        }, this.checkInterval);
    }

    // Create a new payment receipt
    async createPaymentReceipt(address, amount, webhookUrl, orderId = null) {
        const database = await getDatabase();
        const receiptsCollection = database.collection("payment_receipts");
        const utxoCollection = database.collection("utxo");

        // Get current UTXOs for this address
        const currentUtxos = await utxoCollection.find({ address: address }).toArray();
        const currentBalance = currentUtxos.reduce((sum, utxo) => sum + utxo.value, 0);

        const receipt = {
            address: address,
            amount: amount,
            webhookUrl: webhookUrl,
            orderId: orderId,
            status: "pending",
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + this.timeout),
            paidAmount: currentBalance, // Start with current balance
            transactions: [],
            // Track which UTXOs we've already counted
            countedUtxos: currentUtxos.map(utxo => utxo._id.toString())
        };

        const result = await receiptsCollection.insertOne(receipt);
        receipt._id = result.insertedId;

        // Also store in active payments for monitoring
        this.activePayments.set(address, receipt);

        return receipt;
    }

    // Check all active payments for completion
    async checkActivePayments() {
        const database = await getDatabase();
        const utxoCollection = database.collection("utxo");
        const receiptsCollection = database.collection("payment_receipts");

        // Create a copy of active payments to avoid modification during iteration
        const paymentsToCheck = Array.from(this.activePayments.entries());

        for (const [address, receipt] of paymentsToCheck) {
            try {
                // Check if receipt has expired
                if (new Date() > receipt.expiresAt) {
                    await this.handlePaymentTimeout(receipt);
                    this.activePayments.delete(address);
                    continue;
                }

                // Check if payment is complete
                // Get all UTXOs for this address
                const allUtxos = await utxoCollection.find({ address: address }).toArray();

                // Only count UTXOs that weren't present when receipt was created
                let newUtxos = [];
                const countedUtxoIds = new Set(receipt.countedUtxos || []);

                allUtxos.forEach(utxo => {
                    if (!countedUtxoIds.has(utxo._id.toString())) {
                        newUtxos.push(utxo);
                    }
                });

                const totalPaid = newUtxos.reduce((sum, utxo) => sum + utxo.value, 0);

                if (totalPaid >= receipt.amount) {
                    await this.handlePaymentComplete(receipt, totalPaid);
                    this.activePayments.delete(address);
                } else {
                    // Update the paid amount in database if it changed
                    if (totalPaid !== receipt.paidAmount) {
                        // Update the counted UTXOs to include all current UTXOs
                        const allUtxoIds = allUtxos.map(utxo => utxo._id.toString());
                        await receiptsCollection.updateOne(
                            { _id: receipt._id },
                            {
                                $set: {
                                    paidAmount: totalPaid,
                                    updatedAt: new Date(),
                                    countedUtxos: allUtxoIds
                                }
                            }
                        );
                    }
                }
            } catch (error) {
                console.error('Error checking payment:', error);
            }
        }
    }

    // Handle payment completion
    async handlePaymentComplete(receipt, totalPaid) {
        const database = await getDatabase();
        const receiptsCollection = database.collection("payment_receipts");

        // Update receipt status in database
        await receiptsCollection.updateOne(
            { _id: receipt._id },
            {
                $set: {
                    status: "completed",
                    paidAmount: totalPaid,
                    completedAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );

        // Send success webhook
        await this.sendWebhook(receipt.webhookUrl, {
            status: "success",
            orderId: receipt.orderId,
            address: receipt.address,
            amount: receipt.amount,
            paidAmount: totalPaid,
            timestamp: new Date()
        });

        console.log(`Payment completed for order ${receipt.orderId}`);
    }

    // Handle payment timeout
    async handlePaymentTimeout(receipt) {
        const database = await getDatabase();
        const receiptsCollection = database.collection("payment_receipts");

        // Update receipt status in database
        await receiptsCollection.updateOne(
            { _id: receipt._id },
            {
                $set: {
                    status: "timeout",
                    timeoutAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );

        // Send timeout webhook
        await this.sendWebhook(receipt.webhookUrl, {
            status: "timeout",
            orderId: receipt.orderId,
            address: receipt.address,
            amount: receipt.amount,
            paidAmount: receipt.paidAmount,
            timestamp: new Date()
        });

        console.log(`Payment timeout for order ${receipt.orderId}`);
    }

    // Send webhook to external API
    async sendWebhook(url, data) {
        try {
            await axios.post(url, data, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000 // 10 second timeout
            });
        } catch (error) {
            console.error('Webhook failed:', error.message);
        }
    }

    // Get payment receipt status
    async getPaymentStatus(orderId) {
        const database = await getDatabase();
        const receiptsCollection = database.collection("payment_receipts");
        return await receiptsCollection.findOne({ orderId: orderId });
    }

    // Get all active payments for an address
    getActivePaymentsForAddress(address) {
        return Array.from(this.activePayments.entries())
            .filter(([addr]) => addr === address)
            .map(([addr, receipt]) => receipt);
    }

    // Get all pending payments (for debugging/admin purposes)
    async getAllPendingPayments() {
        const database = await getDatabase();
        const receiptsCollection = database.collection("payment_receipts");
        return await receiptsCollection.find({ status: "pending" }).toArray();
    }

    // Cancel a payment (admin function)
    async cancelPayment(orderId) {
        const database = await getDatabase();
        const receiptsCollection = database.collection("payment_receipts");

        const receipt = await receiptsCollection.findOne({ orderId: orderId });
        if (receipt && receipt.status === "pending") {
            await receiptsCollection.updateOne(
                { _id: receipt._id },
                {
                    $set: {
                        status: "cancelled",
                        cancelledAt: new Date(),
                        updatedAt: new Date()
                    }
                }
            );

            this.activePayments.delete(receipt.address);
            return true;
        }
        return false;
    }
}

// Initialize payment receipt system
const paymentSystem = new PaymentReceiptSystem();

// Create payment receipt API endpoint (HMAC authenticated)
app.post("/api/payment/receipt", authenticateHMAC, async (req, res) => {
    try {
        const { address, amount, webhookUrl, orderId } = req.body;

        if (!address || !amount || !webhookUrl) {
            return sendJson(res, { error: "Missing required fields: address, amount, webhookUrl" });
        }

        const receipt = await paymentSystem.createPaymentReceipt(
            address,
            amount,
            webhookUrl,
            orderId
        );

        sendJson(res, {
            success: true,
            receiptId: receipt._id,
            status: "created",
            address: receipt.address,
            amount: receipt.amount,
            orderId: receipt.orderId
        });
    } catch (error) {
        console.error('Error creating payment receipt:', error);
        sendJson(res, { error: "Failed to create payment receipt" });
    }
});

// Get payment status API endpoint (HMAC authenticated)
app.get("/api/payment/status/:orderId", authenticateHMAC, async (req, res) => {
    try {
        const { orderId } = req.params;
        const status = await paymentSystem.getPaymentStatus(orderId);

        if (!status) {
            return sendJson(res, { error: "Payment receipt not found" });
        }

        sendJson(res, status);
    } catch (error) {
        console.error('Error getting payment status:', error);
        sendJson(res, { error: "Failed to get payment status" });
    }
});

// Get all pending payments (HMAC authenticated)
app.get("/api/payment/pending", authenticateHMAC, async (req, res) => {
    try {
        const pendingPayments = await paymentSystem.getAllPendingPayments();
        sendJson(res, { pendingPayments });
    } catch (error) {
        console.error('Error getting pending payments:', error);
        sendJson(res, { error: "Failed to get pending payments" });
    }
});

// Cancel a payment (HMAC authenticated)
app.post("/api/payment/cancel/:orderId", authenticateHMAC, async (req, res) => {
    try {
        const { orderId } = req.params;
        const cancelled = await paymentSystem.cancelPayment(orderId);

        if (cancelled) {
            sendJson(res, { success: true, message: "Payment cancelled successfully" });
        } else {
            sendJson(res, { error: "Payment not found or already completed/timeout" });
        }
    } catch (error) {
        console.error('Error cancelling payment:', error);
        sendJson(res, { error: "Failed to cancel payment" });
    }
});

// Generate QR code for payment address (HMAC authenticated)
app.get("/api/payment/qr/:address", authenticateHMAC, async (req, res) => {
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

        sendJson(res, {
            success: true,
            address: address,
            qrContent: qrContent,
            qrDataUrl: qrDataUrl
        });
    } catch (error) {
        console.error('Error generating QR code:', error);
        sendJson(res, { error: "Failed to generate QR code" });
    }
});

// Generate QR code with amount (HMAC authenticated)
app.get("/api/payment/qr/:address/:amount", authenticateHMAC, async (req, res) => {
    try {
        const { address, amount } = req.params;

        if (!address || !amount) {
            return sendJson(res, { error: "Address and amount parameters are required" });
        }

        // Create QR code content in the format: curecoin:address?amount=amount
        const qrContent = `curecoin:${address}?amount=${amount}`;

        // Generate QR code as data URL
        const qrDataUrl = await qr.toDataURL(qrContent, {
            width: 300,
            margin: 1,
            errorCorrectionLevel: 'M'
        });

        sendJson(res, {
            success: true,
            address: address,
            amount: amount,
            qrContent: qrContent,
            qrDataUrl: qrDataUrl
        });
    } catch (error) {
        console.error('Error generating QR code:', error);
        sendJson(res, { error: "Failed to generate QR code" });
    }
});

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
    const database = await getDatabase();
    const Blocks = database.collection("blocks");
    let limit = Number(req.query.limit || 30);
    if (limit > 500) limit = 500;
    if (limit < 1) limit = 1;
    const blocks = await Blocks.find({})
        .sort({ height: -1 })
        .limit(limit)
        .toArray();
    sendJson(res, { limit, blocks });
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

// GET rich list endpoint
const getRichList = async (req, res) => {
    const database = await getDatabase();
    const utxoCollection = database.collection('utxo');

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

    // Format the response to include rank
    const formattedRichList = richList.map((item, index) => ({
        rank: index + 1,
        address: item._id,
        balance: item.balance,
        utxoCount: item.utxoCount
    }));

    sendJson(res, { richList: formattedRichList });
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

const Supply = require("./supply.js")

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


const cache = {};


// Register routes
app.get("/api/block/:height", getBlockByHeight);
app.get("/api/tx/:txid", getTransactionByTxid);
app.get("/api/address/:address", getAddressTransactions);
app.get("/api/utxo/:address", getUTXOsByAddress);
app.get("/api/blocks/latest", getLatestBlock);
app.get("/api/blocks", getLatestBlocks);
app.get("/api/block/:height/txs", getTransactionsByBlockHeightOrHash);
app.get("/api/block/hash/:hash", getBlockByHash);
app.get("/blocks/height", getExplorerHeight);
app.get("/api/richlist", getRichList);
app.get("/api/supply", getSupply);
app.get("/api/address/:address/txs/count", getAddressTxCount);

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log`API running on port ${PORT}`);