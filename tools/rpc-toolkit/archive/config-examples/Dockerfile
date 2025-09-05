FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV RPC_URL=https://rpc.anoncenomics.com

# Run the application
CMD ["node", "node_polkadot_example.mjs"]
