require('dotenv').config();
const { initDatabase, closePool } = require('../db/init');
const UserModel = require('../models/User');
const ClientModel = require('../models/Client');

async function seedDatabase() {
  console.log('🌱 Initializing database with seed data...\n');
  
  try {
    const pool = await initDatabase();
    const User = new UserModel(pool);
    const Client = new ClientModel(pool);
    
    console.log('Creating demo user...');
    const existingUser = await User.findByEmail('demo@vaultsso.com');
    if (!existingUser) {
      await User.create({
        username: 'demo@vaultsso.com',
        email: 'demo@vaultsso.com',
        password: 'demo123',
        name: 'Alexander Chen',
        avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAeJvKl7fU1iqZh6zOZs1aafVqUuYiG5yITDbH2UYR4RvaLznuMOqj8sGGOh1goH16sh4Jq75d9IeEbhUtLzk8V_ShUGkRIRYsEqo47Ads_1pw_6ySjt3T4vIDRjraWDGUoLRxXLVv7EFVRgKp9Mjfa4sHjuoM9MM5o2VIPg0rF66x0vP9_zEV3twEjYqDi1fMs_24JUSsFwuNUa7Kdjm6U7EfrzZzUMwm4IGtYm7pSX12FASsT6BxFQxtLiP-qzQ-YOymo-NhULTCI',
        emailVerified: true,
        role: 'admin'
      });
      console.log('✅ Demo user created: demo@vaultsso.com / demo123');
    } else {
      console.log('ℹ️  Demo user already exists');
    }
    
    console.log('\nCreating demo clients...');
    
    const clients = [
      {
        id: 'salesforce-prod',
        name: 'Salesforce',
        secret: 'salesforce-secret',
        redirectUris: ['https://login.salesforce.com/oauth2/callback', 'http://localhost:3000/callback', 'http://localhost:3146/callback'],
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        logoUrl: 'https://login.salesforce.com/favicon.ico'
      },
      {
        id: 'slack-workspace',
        name: 'Slack',
        secret: 'slack-secret',
        redirectUris: ['https://slack.com/oauth2/callback', 'http://localhost:3000/callback', 'http://localhost:3146/callback'],
        scopes: ['openid', 'profile', 'email'],
        logoUrl: 'https://slack.com/favicon.ico'
      },
      {
        id: 'github-enterprise',
        name: 'GitHub',
        secret: 'github-secret',
        redirectUris: ['https://github.com/login/oauth/callback', 'http://localhost:3000/callback', 'http://localhost:3146/callback'],
        scopes: ['openid', 'profile', 'email', 'repo'],
        logoUrl: 'https://github.com/favicon.ico'
      },
      {
        id: 'azure-portal',
        name: 'Azure Portal',
        secret: 'azure-secret',
        redirectUris: ['https://portal.azure.com/oauth2/callback', 'http://localhost:3000/callback', 'http://localhost:3146/callback'],
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        logoUrl: 'https://portal.azure.com/favicon.ico'
      }
    ];
    
    for (const clientData of clients) {
      const existing = await Client.findById(clientData.id);
      if (!existing) {
        await Client.create(clientData);
        console.log(`✅ Client created: ${clientData.name}`);
      } else {
        console.log(`ℹ️  Client already exists: ${clientData.name}`);
      }
    }
    
    console.log('\n✨ Database initialization complete!\n');
    console.log('You can now start the server with: npm start');
    
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    process.exit(1);
  }
}

seedDatabase();
