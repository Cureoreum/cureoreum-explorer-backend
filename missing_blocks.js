require('dotenv').config();
const db = require("./mongo.js");

async function checkBlockExists(height) {
    try {
        const database = await db();
        const Blocks = database.collection("blocks");
        const block = await Blocks.findOne({ height: height });
        return block !== null;
    } catch (error) {
        console.error(`Error checking block ${height}:`, error);
        return false;
    }
}

async function checkBlocksExist(heights) {
    try {
        const database = await db();
        const Blocks = database.collection("blocks");
        const blocks = await Blocks.find({ height: { $in: heights } }).toArray();
        const existingHeights = new Set(blocks.map(block => block.height));
        return heights.map(height => ({
            height,
            exists: existingHeights.has(height)
        }));
    } catch (error) {
        console.error(`Error checking blocks:`, error);
        return heights.map(height => ({ height, exists: false }));
    }
}

async function getBlockHeightsInRange(startHeight, endHeight) {
    try {
        const database = await db();
        const Blocks = database.collection("blocks");
        const blocks = await Blocks.find(
            { height: { $gte: startHeight, $lte: endHeight } },
            { projection: { height: 1 } }
        ).toArray();
        return blocks.map(block => block.height);
    } catch (error) {
        console.error(`Error getting block heights in range:`, error);
        return [];
    }
}

async function getMissingBlocks(startHeight, endHeight) {
    try {
        const database = await db();
        const Blocks = database.collection("blocks");
        const existingBlocks = await Blocks.find(
            { height: { $gte: startHeight, $lte: endHeight } },
            { projection: { height: 1 } }
        ).toArray();

        const existingHeights = new Set(existingBlocks.map(block => block.height));
        const missingHeights = [];

        for (let i = startHeight; i <= endHeight; i++) {
            console.log(i);
            if (!existingHeights.has(i)) {
                missingHeights.push(i);
            }
        }

        return missingHeights;
    } catch (error) {
        console.error(`Error getting missing blocks:`, error);
        return [];
    }
}

// Example usage:
async function main() {
    let max = 1188063;
    const missing = await getMissingBlocks(1, max);
    console.log(`Missing blocks in range 1-${max}:`, missing);
    process.exit(0)
}

// Uncomment the line below to run the example
// main();

module.exports = {
    checkBlockExists,
    checkBlocksExist,
    getBlockHeightsInRange,
    getMissingBlocks
};

main();