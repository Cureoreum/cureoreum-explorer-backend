const db = require("./mongo");

async function applyTransaction(tx) {
    const database = await db();
    const UTXO = database.collection("utxo");

    // Spend inputs
    for (const vin of tx.vin) {
        if (!vin.txid) continue;
        await UTXO.deleteOne({
            txid: vin.txid,
            vout: vin.vout
        });
    }

    // Create outputs
    for (const vout of tx.vout) {
        const address = vout.scriptPubKey.addresses?.[0];
        if (!address) continue;

        await UTXO.insertOne({
            txid: tx.txid,
            vout: vout.n,
            value: vout.value,
            address
        });
    }
}

module.exports = { applyTransaction };
