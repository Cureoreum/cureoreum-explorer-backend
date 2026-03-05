const { spawn } = require('child_process');

const scripts = [
    'indexer.js',
    'apiserver.js',
];

const pkg = require("./package.json");

console.log("Running CureBlockIndexer "+pkg.version);

scripts.forEach((script) => {
    const process = spawn('node', [script], {
        stdio: 'inherit',
        shell: true
    });

    process.on('close', (code) => {
        console.log(`🔚 ${script} exited with code ${code}`);
    });

    process.on('error', (err) => {
        console.error(`❌ Error running ${script}:`, err.message);
    });

    console.log(`🚀 Launched ${script}`);
});
