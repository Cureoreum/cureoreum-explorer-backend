//require('dotenv').config();

const { MongoClient } = require("mongodb");

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

async function db() {
    if (!client.topology) await client.connect();
    return client.db("curecoin_explorer");
}

module.exports = db;
