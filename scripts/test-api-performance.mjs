#!/usr/bin/env node

/**
 * API Performance Test Script
 * Compares performance between original and v2 endpoints
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001'; // Using port 3001 as 3000 seems occupied

async function measureApiCall(url) {
  const start = Date.now();
  try {
    const response = await fetch(url);
    const data = await response.json();
    const end = Date.now();
    return {
      success: true,
      time: end - start,
      dataSize: JSON.stringify(data).length,
      recordCount: Array.isArray(data) ? data.length : 0
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      time: Date.now() - start
    };
  }
}

async function runTests() {
  console.log('🔬 API Performance Test\n');
  console.log('Testing endpoints on', BASE_URL);
  console.log('═══════════════════════════════════════\n');
  
  const tests = [
    { name: 'Original API - Limit 50', url: `${BASE_URL}/api/epochs?limit=50` },
    { name: 'V2 API - Limit 50', url: `${BASE_URL}/api/epochs-v2?limit=50` },
    { name: 'Original API - Limit 200', url: `${BASE_URL}/api/epochs?limit=200` },
    { name: 'V2 API - Limit 200', url: `${BASE_URL}/api/epochs-v2?limit=200` },
    { name: 'Original API - Limit ALL', url: `${BASE_URL}/api/epochs?limit=all` },
    { name: 'V2 API - Limit ALL', url: `${BASE_URL}/api/epochs-v2?limit=all` },
  ];
  
  for (const test of tests) {
    console.log(`Testing: ${test.name}`);
    console.log(`URL: ${test.url}`);
    
    const result = await measureApiCall(test.url);
    
    if (result.success) {
      console.log(`✅ Success`);
      console.log(`   Time: ${result.time}ms`);
      console.log(`   Data Size: ${(result.dataSize / 1024).toFixed(2)} KB`);
      console.log(`   Records: ${result.recordCount}`);
    } else {
      console.log(`❌ Failed: ${result.error}`);
      console.log(`   Time: ${result.time}ms`);
    }
    console.log('---\n');
  }
  
  // Performance comparison summary
  console.log('═══════════════════════════════════════');
  console.log('📊 Performance Summary\n');
  
  // Test with sample parameter for large datasets
  const sampleTests = [
    { name: 'Original API - ALL with sample=500', url: `${BASE_URL}/api/epochs?limit=all&sample=500` },
    { name: 'V2 API - ALL with sample=500', url: `${BASE_URL}/api/epochs-v2?limit=all&sample=500` },
  ];
  
  for (const test of sampleTests) {
    console.log(`Testing: ${test.name}`);
    const result = await measureApiCall(test.url);
    if (result.success) {
      console.log(`   Time: ${result.time}ms, Records: ${result.recordCount}`);
    } else {
      console.log(`   Failed: ${result.error}`);
    }
  }
  
  console.log('\n✨ Test Complete!');
}

// Check if server is available first
async function checkServer() {
  try {
    const response = await fetch(`${BASE_URL}/api/epochs?limit=1`);
    if (!response.ok && response.status === 404) {
      // Try port 3001
      const BASE_URL_ALT = 'http://localhost:3001';
      const response2 = await fetch(`${BASE_URL_ALT}/api/epochs?limit=1`);
      if (response2.ok) {
        console.log('Server found on port 3001');
        return BASE_URL_ALT;
      }
    }
    return response.ok ? BASE_URL : null;
  } catch (error) {
    // Server not ready yet
    return null;
  }
}

async function main() {
  console.log('Checking if server is available...');
  
  let serverUrl = await checkServer();
  if (!serverUrl) {
    console.log('⚠️  Server not available on port 3000 or 3001');
    console.log('Please start the Next.js dev server first: npm run dev');
    process.exit(1);
  }
  
  await runTests();
}

main().catch(console.error);
