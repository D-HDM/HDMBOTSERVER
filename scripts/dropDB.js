#!/usr/bin/env node
// DNS CONFIGURATION
// ============================================
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  title: (msg) => console.log(`\n${colors.bright}${colors.blue}${msg}${colors.reset}\n`),
  line: () => console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`)
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hdm_bot';

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4
    });
    log.success(`MongoDB connected: ${mongoose.connection.host}`);
    return true;
  } catch (err) {
    log.error(`MongoDB connection failed: ${err.message}`);
    return false;
  }
}

async function dropDatabase() {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    
    if (collections.length === 0) {
      log.info('Database is already empty.');
      return true;
    }
    
    log.warning(`Found ${collections.length} collection(s):`);
    collections.forEach(col => console.log(`   - ${col.name}`));
    
    const confirm = await question(`\n${colors.red}Type "DROP DATABASE" to confirm deletion: ${colors.reset}`);
    
    if (confirm !== 'DROP DATABASE') {
      log.info('Operation cancelled.');
      return false;
    }
    
    log.warning('Dropping all collections...');
    
    for (const collection of collections) {
      await db.dropCollection(collection.name);
      log.success(`Dropped: ${collection.name}`);
    }
    
    log.success('Database cleared successfully!');
    return true;
  } catch (err) {
    log.error(`Failed to drop database: ${err.message}`);
    return false;
  }
}

async function dropSpecificCollection(collectionName) {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({ name: collectionName }).toArray();
    
    if (collections.length === 0) {
      log.error(`Collection "${collectionName}" not found.`);
      return false;
    }
    
    await db.dropCollection(collectionName);
    log.success(`Dropped collection: ${collectionName}`);
    return true;
  } catch (err) {
    log.error(`Failed to drop collection: ${err.message}`);
    return false;
  }
}

async function showMenu() {
  log.line();
  log.title('🗑️ HDM Database Cleanup');
  log.line();
  console.log(`${colors.cyan}1.${colors.reset} Drop ENTIRE database (all collections)`);
  console.log(`${colors.cyan}2.${colors.reset} Drop specific collection`);
  console.log(`${colors.cyan}3.${colors.reset} List all collections`);
  console.log(`${colors.cyan}4.${colors.reset} Exit`);
  log.line();
  
  const choice = await question(`${colors.yellow}Select option (1-4): ${colors.reset}`);
  return choice;
}

async function listCollections() {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    
    if (collections.length === 0) {
      log.info('No collections found.');
    } else {
      console.log(`\n${colors.cyan}📋 Collections:${colors.reset}`);
      collections.forEach((col, index) => {
        console.log(`   ${index + 1}. ${col.name}`);
      });
    }
    return collections;
  } catch (err) {
    log.error(`Failed to list collections: ${err.message}`);
    return [];
  }
}

async function main() {
  log.line();
  log.title('🗑️ HDM Database Cleanup Tool');
  log.line();
  
  console.log(`${colors.cyan}📋 Database URI:${colors.reset} ${MONGODB_URI.replace(/\/\/.*@/, '//****:****@')}`);
  log.line();
  
  const connected = await connectDB();
  if (!connected) {
    rl.close();
    process.exit(1);
  }
  
  let running = true;
  
  while (running) {
    const choice = await showMenu();
    
    switch (choice) {
      case '1':
        await dropDatabase();
        break;
      case '2':
        await listCollections();
        const collectionName = await question(`\n${colors.yellow}Enter collection name to drop: ${colors.reset}`);
        if (collectionName) {
          await dropSpecificCollection(collectionName);
        }
        break;
      case '3':
        await listCollections();
        break;
      case '4':
        running = false;
        log.info('Exiting...');
        break;
      default:
        log.warning('Invalid option. Please select 1-4');
    }
    
    if (running) {
      console.log('');
      await question('Press Enter to continue...');
    }
  }
  
  await mongoose.disconnect();
  log.success('Disconnected from MongoDB');
  rl.close();
}

main().catch((err) => {
  log.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});