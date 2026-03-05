require('dotenv').config();

const rpc = require("./curerpc.js");
const db = require("./mongo.js");
const { getAddressFromVout } = require("./address.js");
const { applyTransaction } = require("./utxo.js");

async function getLocalTip() {
    const database = await db();
    const Blocks = database.collection("blocks");
    const b = await Blocks.findOne({}, { sort: { height: -1 }});
    return b ? b.height : -1;
}

async function getNodeTip() {
    return await rpc("getblockcount");
}

async function validateBlockComplete(block, height) {
    // Basic validation - check if block has expected structure
    if (!block || !block.hash || !block.previousblockhash || !block.tx) {
        throw new Error(`Block ${height} is incomplete or invalid`);
    }

    // Check if block has transactions (shouldn't be empty for mainnet)
    if (block.tx.length === 0) {
        console.warn(`Warning: Block ${height} has no transactions`);
        // You might want to handle this differently based on your needs
    }

    return true;
}

async function indexBlock(height) {
    const database = await db();
    const Blocks = database.collection("blocks");
    const Txs = database.collection("txs");
    const Addr = database.collection("address_txs");

    try {
        // Get block hash first
        const hash = await rpc("getblockhash", [height]);

        // Get full block with transactions
        const block = await rpc("getblock", [hash, true]);

        // Validate block completeness
        await validateBlockComplete(block, height);

        // Process transactions
        console.log(height + " has "+block.tx.length+" transactions to process.");

        let i = 0;
        for (const tx of block.tx) {
            await Txs.updateOne(
                { txid: tx.txid },
                { $set: { ...tx, block_height: height }},
                { upsert: true }
            );

            // UTXO update
            await applyTransaction(tx);
            i++;
            console.log(i+"/"+block.tx.length);


            // Address index - receive transactions
            for (const vout of tx.vout) {
                const a = getAddressFromVout(vout);
                if (!a) continue;
                await Addr.insertOne({
                    address: a,
                    txid: tx.txid,
                    block_height: height,
                    value: vout.value,
                    type: "receive"
                });
            }

            // Address index - spend transactions
            for (const vin of tx.vin) {
                if (!vin.txid) continue;
                try {
                    const prev = await rpc("getrawtransaction", [vin.txid, 1]);
                    const prevOut = prev.vout[vin.vout];
                    const a = getAddressFromVout(prevOut);
                    if (!a) continue;
                    await Addr.insertOne({
                        address: a,
                        txid: tx.txid,
                        block_height: height,
                        value: -prevOut.value,
                        type: "spend"
                    });
                } catch (e) {
                    console.warn(`Failed to process input ${vin.txid}:${vin.vout} in block ${height}:`, e.message);
                    // Continue processing other transactions rather than failing completely
                }
            }
        }

        // Store block info
        await Blocks.updateOne(
            { height },
            { $set: {
                    height,
                    hash,
                    prevhash: block.previousblockhash,
                    time: block.time,
                    txCount: block.tx.length
                }},
            { upsert: true }
        );

        console.log(`Successfully indexed block ${height}`);
        return true;

    } catch (error) {
        console.error(`Failed to index block ${height}:`, error.message);
        throw error; // Re-throw to trigger rollback logic in main loop
    }
}

async function rollbackToHeight(targetHeight) {
    const database = await db();
    const Blocks = database.collection("blocks");
    const Txs = database.collection("txs");
    const Addr = database.collection("address_txs");

    console.log(`Rolling back to block ${targetHeight}...`);

    // Delete blocks, transactions, and address records at and after target height
    await Blocks.deleteMany({ height: { $gte: targetHeight } });
    await Txs.deleteMany({ block_height: { $gte: targetHeight } });
    await Addr.deleteMany({ block_height: { $gte: targetHeight } });

    console.log(`Rollback to block ${targetHeight} completed`);
}

async function main() {
    await indexBlock(769200);//next 391813
    process.exit(0);
}

main();