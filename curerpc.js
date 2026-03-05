//require('dotenv').config();

const axios = require('axios');

const curerpc = axios.create({
    baseURL: `http://${process.env.CURE_RPC_HOST}:${process.env.CURE_RPC_PORT}`,
    auth: {
        username: process.env.CURE_RPCUSER,
        password: process.env.CURE_RPCPASSWORD
    },
    timeout: 30000, // Add timeout for better error handling
    headers: {
        'Content-Type': 'application/json'
    }
});

async function call(method, params = []) {
    try {
        const response = await curerpc.post('/', {
            jsonrpc: '1.0',
            id: 'indexer',
            method,
            params
        });

        // Handle potential RPC errors in the response
        if (response.data.error) {
            throw new Error(`RPC Error: ${response.data.error.message} (code: ${response.data.error.code})`);
        }

        return response.data.result;
    } catch (error) {
        if (error.response) {
            if (error.response.status === 403) {
                console.error(`RPC 403 Forbidden: check RPC_USER, RPC_PASS, and rpcallowip in curecoin.conf or daemon flags.`);
            } else {
                console.error(`RPC Error ${error.response.status}: ${error.response.statusText}`);
            }
            // Log the actual error from the RPC response
            if (error.response.data && error.response.data.error) {
                console.error(`RPC Error Details: ${error.response.data.error.message}`);
            }
        } else if (error.code === 'ECONNRESET') {
            console.error('RPC connection reset: server closed the connection. Check firewall or node availability.');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('RPC connection refused: check if the CURE daemon is running.');
        } else if (error.code === 'ENOTFOUND') {
            console.error('RPC host not found: check CURE_RPC_HOST environment variable.');
        } else {
            console.error('RPC Error:', error.message);
        }
        throw error;
    }
}

module.exports = call;