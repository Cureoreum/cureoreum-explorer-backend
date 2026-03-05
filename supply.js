require('dotenv').config();
const db = require("./mongo.js");

const getDatabase = async () => {
    return await db();
};

async function calculateTotalCoins() {
    try {
        const db = await getDatabase();

        // Method 1: Sum all UTXOs (most accurate for current supply)
        const utxoCollection = db.collection('utxo');
        const utxoCount = await utxoCollection.countDocuments();

        const totalFromUtxos = await utxoCollection.aggregate([
            { $group: { _id: null, total: { $sum: "$value" } } }
        ]).toArray();

        const utxoSupply = totalFromUtxos[0]?.total || 0;

        // Method 2: Sum all transaction outputs (vout values) from txs collection
        const txsCollection = db.collection('txs');
        const txCount = await txsCollection.countDocuments();

        // Aggregate all vout values from transactions
        const totalFromTxs = await txsCollection.aggregate([
            { $unwind: "$vout" },
            { $group: { _id: null, total: { $sum: "$vout.value" } } }
        ]).toArray();

        const txSupply = totalFromTxs[0]?.total || 0;

        // Method 3: Calculate from address_txs
        const addressTxsCollection = db.collection('address_txs');
        const txTxsCount = await addressTxsCollection.countDocuments();

        const totalFromAddressTxs = await addressTxsCollection.aggregate([
            { $group: { _id: null, total: { $sum: "$value" } } }
        ]).toArray();

        const addressTxSupply = totalFromAddressTxs[0]?.total || 0;

        // Method 4: Get detailed breakdown by address from UTXOs
        const topAddresses = await utxoCollection.aggregate([
            { $group: { _id: "$address", balance: { $sum: "$value" } } },
            { $sort: { balance: -1 } },
            { $limit: 10 }
        ]).toArray();

        // Method 5: Calculate circulating supply with additional insights
        // Fixed: Using aggregation instead of distinct to avoid 16MB limit
        const totalUniqueAddresses = await utxoCollection.aggregate([
            { $group: { _id: "$address" } },
            { $count: "total" }
        ]).toArray();

        const totalAddressesCount = totalUniqueAddresses.length > 0 ? totalUniqueAddresses[0].total : 0;

        // Get UTXO statistics
        const utxoStats = await utxoCollection.aggregate([
            {
                $group: {
                    _id: null,
                    totalUtxos: { $sum: 1 },
                    totalValue: { $sum: "$value" },
                    avgValue: { $avg: "$value" },
                    maxValue: { $max: "$value" },
                    minValue: { $min: "$value" }
                }
            }
        ]).toArray();

        if (utxoStats.length > 0) {
            const stats = utxoStats[0];
        }

        // Method 6: Analyze transaction types and block heights
        const blockStats = await txsCollection.aggregate([
            {
                $group: {
                    _id: null,
                    totalBlocks: { $max: "$block_height" },
                    totalTransactions: { $sum: 1 },
                    avgBlockHeight: { $avg: "$block_height" }
                }
            }
        ]).toArray();

        if (blockStats.length > 0) {
            const bStats = blockStats[0];
        }

        // Method 7: Calculate coin distribution
        const distribution = await utxoCollection.aggregate([
            {
                $bucket: {
                    groupBy: "$value",
                    boundaries: [0, 1, 10, 100, 1000, 10000, 100000, Infinity],
                    default: "Other",
                    output: {
                        count: { $sum: 1 },
                        total: { $sum: "$value" }
                    }
                }
            }
        ]).toArray();

        // Create JSON result
        const result = {
            totalSupply: utxoSupply,
            uniqueAddresses: totalAddressesCount,
            totalUtxos: utxoCount,
            totalTransactions: txCount,
            totalBlocks: blockStats[0]?.totalBlocks || 0,
            utxoStats: utxoStats[0] || null,
            transactionStats: {
                totalTransactions: txCount,
                totalBlocks: blockStats[0]?.totalBlocks || 0,
                averageBlockHeight: blockStats[0]?.avgBlockHeight || 0
            },
            coinDistribution: distribution,
            topAddresses: topAddresses,
            calculationMethods: {
                utxoSupply: utxoSupply,
                transactionSupply: txSupply,
                addressTxSupply: addressTxSupply
            },
            consistency: {
                utxoVsTransaction: Math.abs(utxoSupply - txSupply) < 1000,
                utxoVsAddressTx: Math.abs(utxoSupply - addressTxSupply) < 1000
            }
        };

        return result;
    } catch (error) {
        console.error('Error calculating total coins:', error);
        throw error;
    }
}

module.exports = calculateTotalCoins;

// Run the calculation
/*
calculateTotalCoins()
    .then(result => {
        console.log('\n✅ Calculation completed successfully!');
        console.log(`Total Supply: ${result.totalSupply} CURE`);
        console.log(`Unique Addresses: ${result.uniqueAddresses}`);
        console.log(`Total UTXOs: ${result.totalUtxos}`);

        // Optionally save to file
        const fs = require('fs');
        fs.writeFileSync('blockchain_supply.json', JSON.stringify(result, null, 2));
        console.log('Result saved to blockchain_supply.json');

        process.exit(1);
    })
    .catch(error => {
        console.error('❌ Error in calculation:', error);
    });
*/