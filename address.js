function getAddressFromVout(vout) {
    const spk = vout.scriptPubKey;
    if (!spk) return null;
    if (spk.addresses && spk.addresses.length > 0) return spk.addresses[0];
    return null;
}

module.exports = { getAddressFromVout };
