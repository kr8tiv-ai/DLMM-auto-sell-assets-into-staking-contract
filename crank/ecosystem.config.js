module.exports = {
  apps: [
    {
      name: "brain-staking-crank",
      script: "dist/index.js",
      cwd: __dirname,

      // Restart policy
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,

      // Resource limits
      max_memory_restart: "500M",

      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      error_file: "logs/crank-error.log",
      out_file: "logs/crank-out.log",

      // Do not watch files in production
      watch: false,

      // Environment variables — copy from .env or set here
      env: {
        NODE_ENV: "production",
        SOLANA_RPC_URL: "",
        CRANK_KEYPAIR_PATH: "",
        PROGRAM_ID: "",
        STAKING_POOL: "",
        IDL_PATH: "./target/idl/brain_staking.json",
        POLL_INTERVAL_MS: "5000",
        CLAIM_THRESHOLD_LAMPORTS: "1000000",
        JITO_BLOCK_ENGINE_URL: "https://mainnet.block-engine.jito.wtf",
        JITO_TIP_LAMPORTS: "10000",
        HEARTBEAT_PATH: "./heartbeat.txt",
      },
    },
  ],
};
