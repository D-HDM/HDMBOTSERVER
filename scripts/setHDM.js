#!/usr/bin/env node

// ============================================
// DNS CONFIGURATION
// ============================================
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);

console.log('🌐 DNS Configuration:', {
  order: dns.getDefaultResultOrder(),
  servers: dns.getServers()
});

// ============================================
// ENVIRONMENT VARIABLES
// ============================================
require('dotenv').config();

const mongoose = require('mongoose');
const readline = require('readline');
const bcrypt = require('bcryptjs');

// Colors for console output
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

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://restomanager_admin:Hdm%402002@cluster0.i5j7cns.mongodb.net/HDM_BOT?retryWrites=true&w=majority';

// User Model Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'super_admin', 'user'], default: 'admin' },
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4
    });
    log.success('MongoDB connected');
    return true;
  } catch (err) {
    log.error(`MongoDB connection failed: ${err.message}`);
    return false;
  }
}

async function createAdmin(email, password, name, role = 'super_admin') {
  try {
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      log.warning(`User ${email} already exists!`);
      return false;
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      email: email.toLowerCase(),
      passwordHash: hashedPassword,
      name: name,
      role: role,
      isActive: true
    });
    
    await user.save();
    log.success(`Admin created: ${email} (${role})`);
    return true;
  } catch (err) {
    log.error(`Failed to create admin: ${err.message}`);
    return false;
  }
}

async function listAdmins() {
  const admins = await User.find({ role: { $in: ['admin', 'super_admin'] } }).sort({ createdAt: 1 });
  if (admins.length === 0) {
    log.info('No admins found');
  } else {
    console.log(`\n${colors.cyan}📋 Existing Admins:${colors.reset}`);
    admins.forEach((admin, index) => {
      const status = admin.isActive ? `${colors.green}Active${colors.reset}` : `${colors.red}Inactive${colors.reset}`;
      console.log(`   ${index + 1}. ${colors.green}${admin.email}${colors.reset} - ${colors.yellow}${admin.role}${colors.reset} - ${status}`);
    });
  }
  return admins;
}

async function createDefaultAdmin() {
  // Read from .env file
  const defaultEmail = process.env.ADMIN_EMAIL || 'davismcintyre5@gmail.com';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'Hdm@2002';
  const defaultName = process.env.ADMIN_NAME || 'DAVIX HDM';
  
  const exists = await User.findOne({ email: defaultEmail.toLowerCase() });
  if (!exists) {
    await createAdmin(defaultEmail, defaultPassword, defaultName, 'super_admin');
    log.success(`Default admin created:`);
    console.log(`   📧 Email: ${defaultEmail}`);
    console.log(`   👤 Name: ${defaultName}`);
    console.log(`   🔑 Password: ${defaultPassword}`);
    console.log(`   👑 Role: super_admin`);
  } else {
    log.info(`Default admin already exists: ${defaultEmail}`);
  }
}

async function createManualAdmin() {
  log.line();
  log.title('📝 Create New Admin');
  log.line();
  
  const email = await question(`${colors.yellow}📧 Enter admin email: ${colors.reset}`);
  if (!email || !email.includes('@')) {
    log.error('Invalid email address!');
    return false;
  }
  
  const name = await question(`${colors.yellow}👤 Enter admin name: ${colors.reset}`);
  if (!name) {
    log.error('Name is required!');
    return false;
  }
  
  const password = await question(`${colors.yellow}🔑 Enter admin password: ${colors.reset}`);
  if (!password || password.length < 6) {
    log.error('Password must be at least 6 characters!');
    return false;
  }
  
  const confirmPassword = await question(`${colors.yellow}🔑 Confirm admin password: ${colors.reset}`);
  if (password !== confirmPassword) {
    log.error('Passwords do not match!');
    return false;
  }
  
  console.log(`\n${colors.cyan}Role options:${colors.reset}`);
  console.log('   1. Super Admin (full access)');
  console.log('   2. Admin (limited access)');
  console.log('   3. User (read-only)');
  
  const roleChoice = await question(`${colors.yellow}👑 Select role (1-3): ${colors.reset}`);
  let role = 'super_admin';
  if (roleChoice === '2') role = 'admin';
  if (roleChoice === '3') role = 'user';
  
  const success = await createAdmin(email, password, name, role);
  return success;
}

async function resetAdminPassword() {
  await listAdmins();
  
  const email = await question(`${colors.yellow}📧 Enter admin email to reset password: ${colors.reset}`);
  const admin = await User.findOne({ email: email.toLowerCase() });
  
  if (!admin) {
    log.error(`Admin ${email} not found!`);
    return false;
  }
  
  console.log(`\n${colors.cyan}Admin details:${colors.reset}`);
  console.log(`   Email: ${admin.email}`);
  console.log(`   Name: ${admin.name}`);
  console.log(`   Role: ${admin.role}`);
  
  const newPassword = await question(`${colors.yellow}🔑 Enter new password: ${colors.reset}`);
  if (!newPassword || newPassword.length < 6) {
    log.error('Password must be at least 6 characters!');
    return false;
  }
  
  const confirmPassword = await question(`${colors.yellow}🔑 Confirm new password: ${colors.reset}`);
  if (newPassword !== confirmPassword) {
    log.error('Passwords do not match!');
    return false;
  }
  
  admin.passwordHash = await bcrypt.hash(newPassword, 10);
  admin.updatedAt = new Date();
  await admin.save();
  
  log.success(`Password reset for ${email}`);
  console.log(`   New password: ${newPassword}`);
  return true;
}

async function toggleAdminStatus() {
  await listAdmins();
  
  const email = await question(`${colors.yellow}📧 Enter admin email to toggle status: ${colors.reset}`);
  const admin = await User.findOne({ email: email.toLowerCase() });
  
  if (!admin) {
    log.error(`Admin ${email} not found!`);
    return false;
  }
  
  admin.isActive = !admin.isActive;
  await admin.save();
  
  log.success(`${email} is now ${admin.isActive ? 'ACTIVE' : 'INACTIVE'}`);
  return true;
}

async function deleteAdmin() {
  await listAdmins();
  
  const email = await question(`${colors.yellow}📧 Enter admin email to delete: ${colors.reset}`);
  const admin = await User.findOne({ email: email.toLowerCase() });
  
  if (!admin) {
    log.error(`Admin ${email} not found!`);
    return false;
  }
  
  console.log(`\n${colors.red}⚠️ WARNING:${colors.reset} You are about to delete:`);
  console.log(`   Email: ${admin.email}`);
  console.log(`   Name: ${admin.name}`);
  console.log(`   Role: ${admin.role}`);
  
  const confirm = await question(`\n${colors.red}Type DELETE to confirm: ${colors.reset}`);
  if (confirm === 'DELETE') {
    await User.deleteOne({ email: email.toLowerCase() });
    log.success(`Deleted ${email}`);
  } else {
    log.info('Cancelled - DELETE not typed');
  }
  return true;
}

async function showMenu() {
  log.line();
  log.title('🔐 HDM Admin Management');
  log.line();
  console.log(`${colors.cyan}1.${colors.reset} Create Default Admin (from .env)`);
  console.log(`${colors.cyan}2.${colors.reset} Create Admin Manually`);
  console.log(`${colors.cyan}3.${colors.reset} List All Admins`);
  console.log(`${colors.cyan}4.${colors.reset} Reset Admin Password`);
  console.log(`${colors.cyan}5.${colors.reset} Enable/Disable Admin`);
  console.log(`${colors.cyan}6.${colors.reset} Delete Admin`);
  console.log(`${colors.cyan}7.${colors.reset} Exit`);
  log.line();
  
  const choice = await question(`${colors.yellow}Select option (1-7): ${colors.reset}`);
  return choice;
}

async function main() {
  log.line();
  log.title('🚀 HDM Admin Setup Script');
  log.line();
  
  // Show current .env values
  console.log(`${colors.cyan}📋 Current .env configuration:${colors.reset}`);
  console.log(`   ADMIN_EMAIL: ${process.env.ADMIN_EMAIL || 'davismcintyre5@gmail.com'}`);
  console.log(`   ADMIN_NAME: ${process.env.ADMIN_NAME || 'DAVIX HDM'}`);
  console.log(`   ADMIN_PASSWORD: ${'*'.repeat(8)}`);
  log.line();
  
  // Connect to database
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
        await createDefaultAdmin();
        break;
      case '2':
        await createManualAdmin();
        break;
      case '3':
        await listAdmins();
        break;
      case '4':
        await resetAdminPassword();
        break;
      case '5':
        await toggleAdminStatus();
        break;
      case '6':
        await deleteAdmin();
        break;
      case '7':
        running = false;
        log.info('Exiting...');
        break;
      default:
        log.warning('Invalid option. Please select 1-7');
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