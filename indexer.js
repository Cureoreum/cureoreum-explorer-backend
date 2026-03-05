require('dotenv').config();
const rpc = require("./curerpc.js");
const db = require("./mongo.js");
const {getAddressFromVout} = require("./address.js");
const {applyTransaction} = require("./utxo.js");

async function getLocalTip() {
    const database = await db();
    const Blocks = database.collection("blocks");
    const b = await Blocks.findOne({}, {sort: {height: -1}});
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

        // Process transactions in batches
        console.log("[" + height + "] has " + block.tx.length + " transactions to process.");
        const batchSize = 10; // Adjust batch size as needed
        const txs = block.tx;
        let batchesCount = Math.round(txs.length / 10);
        batchesCount = batchesCount === 0 ? 1 : batchesCount;
        for (let i = 0; i < txs.length; i += batchSize) {
            const batch = txs.slice(i, i + batchSize);
            const batchIndex = Math.floor(i / batchSize) + 1;
            console.log(`[${height}] Processing batch ${batchIndex}/${batchesCount} with ${batch.length} transactions`);
            // Process batch in parallel
            await Promise.all(batch.map(async (tx, txIndex) => {
                try {
                    console.log(`[${height}] Processing transaction ${txIndex + 1}/${batch.length} in batch ${batchIndex}/${batchesCount}: ${tx.txid}`);
                    await Txs.updateOne(
                        {txid: tx.txid},
                        {$set: {...tx, block_height: height}},
                        {upsert: true}
                    );
                    // UTXO update
                    await applyTransaction(tx);
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
                        }
                    }
                    console.log(`[${height}] Completed transaction ${txIndex + 1}/${batch.length} in batch ${batchIndex}/${batchesCount}: ${tx.txid}`);

                } catch (error) {
                    console.error(`Error processing transaction ${tx.txid} in block ${height}:`, error.message);
                    throw error; // Re-throw to stop processing
                }
            }));


        }
        //let cc = await calculateCreatedCureFromBlock(height);

        // Store block info with created cure amount
        await Blocks.updateOne(
            {height},
            {
                $set: {
                    height,
                    hash,
                    prevhash: block.previousblockhash,
                    time: block.time,
                    txCount: block.tx.length,
                    size: block.size,
                    version: block.version,
                    mint: block.mint,
                    difficulty: block.difficulty,
                    flags: block.flags,
                    proofhash: block.proofhash,
                    entropybit: block.entropybit,
                    nonce: block.nonce,
                    merkleroot: block.merkleroot,
                    confirmations: block.confirmations
                }
            },
            {upsert: true}
        );

       // const ok = await updateCreatedCureForBlock(height);

        console.log(`Successfully indexed block [${height}]`);
        return true;
    } catch (error) {
        console.error(`Failed to index block [${height}]:`, error.message);
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
    await Blocks.deleteMany({height: {$gte: targetHeight}});
    await Txs.deleteMany({block_height: {$gte: targetHeight}});
    await Addr.deleteMany({block_height: {$gte: targetHeight}});
    console.log(`Rollback to block ${targetHeight} completed`);
}

async function main() {
    let lastSuccessfulHeight = -1;
    let retryCount = 0;
    const maxRetries = 5;
    let checkTip = true;
    let checkTimeout = setInterval(async () => {
        checkTip = true;
    }, 30000);
    while (true) {
        try {
            let nodeTip = await rpc("getblockcount");
            let localTip = await getLocalTip();

            if (nodeTip !== localTip) {
                console.log(`Node tip: ${nodeTip}, Local tip: ${localTip} - Local is synchronizing with NodeTip..`);
            } else {
                console.log("Local node is fully synchronized with NodeTip.");
                await new Promise(r => setTimeout(r, 30000));
            }

            while (localTip < nodeTip) {
                if (checkTip) {
                    checkTip = false;
                    let nNodeTip = await getNodeTip();
                    if (nNodeTip !== nodeTip) {
                        console.log(`**** New Node tip: ${nNodeTip}, Local tip: ${localTip} break; resume. ****`);
                        nodeTip = nNodeTip;
                        continue;
                    }
                }
                localTip++;
                console.log("Indexing block [" + localTip + "] of current chain tip: " + nodeTip);
                try {
                    await indexBlock(localTip);
                    lastSuccessfulHeight = localTip;
                    retryCount = 0; // Reset retry count on success
                } catch (error) {
                    console.error(`Block indexing failed: ${error.message}`);
                    // Check if we should retry
                    if (retryCount < maxRetries) {
                        retryCount++;
                        console.log(`Retrying block ${localTip} (attempt ${retryCount}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, 3000 * retryCount)); // Exponential backoff
                        continue; // Retry the same block
                    } else {
                        // If we've failed too many times, rollback and continue
                        console.log(`Max retries exceeded for block ${localTip}. Rolling back...`);
                        await rollbackToHeight(localTip);
                        // Don't increment localTip, so we retry this block
                        retryCount = 0;
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                }
            }
            if (localTip === nodeTip) {
                //await scanMempool();
            }
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            console.error("Indexer error:", e);
            // Even if main loop fails, continue trying
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

main();