// Example for CureCoin rich list
require('dotenv').config();

async function generateCureCoinRichList() {
    const Db = require("./mongo");
    const db = await Db();
    const utxoCollection = db.collection('utxo');

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

    console.log('CureCoin Rich List:');
    richList.forEach((item, index) => {
        console.log(`${index + 1}. Address: ${item._id}, Balance: ${item.balance}, UTXOs: ${item.utxoCount}`);
    });

    process.exit(0);
}

generateCureCoinRichList();