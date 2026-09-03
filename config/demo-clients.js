/**
 * 演示/内置 OAuth2 客户端种子
 * server.js（memory 驱动演示模式）与 scripts/init-db.js（MySQL 初始化）共用，
 * 避免两处列表不同步。
 */
module.exports = [
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
  },
  {
    // AzureKiln 主站（azurekiln.cn）登录入口，首页右上角账户按钮跳转本服务
    id: 'azurekiln-main-site',
    name: 'AzureKilnSite',
    secret: 'main-site-secret',
    redirectUris: ['https://azurekiln.cn/', 'http://localhost:8093/'],
    scopes: ['openid', 'profile', 'email'],
    logoUrl: ''
  }
];
