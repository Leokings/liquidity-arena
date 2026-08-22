import hardhatEthers from "@nomicfoundation/hardhat-ethers";

export default {
  plugins: [hardhatEthers],
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 4221,
      initialBaseFeePerGas: 0,
    },
  },
};
