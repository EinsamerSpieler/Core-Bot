import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/guildConfig.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/commandLoader.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,                        
        GatewayIntentBits.GuildMembers,                
        GatewayIntentBits.GuildMessages,               
        GatewayIntentBits.GuildMessageReactions,       
        GatewayIntentBits.MessageContent,              
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,            
        GatewayIntentBits.GuildBans,                   
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog('Starting TitanBot...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('⚠️  DATABASE RUNNING IN DEGRADED MODE');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }
      
      startupLog('Starting web server...');
      this.startWebServer();
      
      startupLog('Loading commands...');
      await loadCommands(this);
      
      startupLog('Loading handlers...');
      await this.loadHandlers();

      initializeMusic(this);
      
      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      
      startupLog('Registering slash commands...');
      await this.registerCommands();
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    app.use(express.json()); // WICHTIG für Webhooks
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    const host = process.env.WEB_HOST || '0.0.0.0';
    
    // Webhook Endpunkt
    app.post('/webhook/alerts', (req, res) => {
      const { message, channelId } = req.body;
      const targetChannelId = channelId || 'HIER_DEINE_CHANNEL_ID_REIN';
      const channel = this.channels.cache.get(targetChannelId);
      
      if (channel) {
        channel.send(`🔔 **Server-Alert:** ${message || 'Keine Nachricht bereitgestellt.'}`);
        res.status(200).send('OK');
      } else {
        res.status(404).send('Channel nicht gefunden');
      }
    });

    app.get('/', (req, res) => res.status(200).json({ message: 'TitanBot Online' }));

    const startServer = (port) => {
      app.listen(port, host, () => startupLog(`✅ Web Server running on ${host}:${port}`));
    };

    startServer(configuredPort);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', () => checkBirthdays(this));
    cron.schedule('* * * * *', () => checkGiveaways(this));
    cron.schedule('*/15 * * * *', () => this.updateAllCounters());
  }

  async updateAllCounters() {
    if (!this.db) return;
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        for (const counter of counters) {
          if (counter && counter.channelId) await updateCounter(this, guild, counter);
        }
      } catch (error) { logger.error(`Error updating counters:`, error); }
    }
  }

  async loadHandlers() {
    const handlers = [{ path: 'events' }, { path: 'interactions' }];
    for (const handler of handlers) {
      const module = await import(`./handlers/${handler.path}.js`);
      await module.default(this);
    }
  }

  async registerCommands() {
    const { clientId, guildId, multiGuild } = this.config.bot;
    await registerSlashCommands(this, { clientId, guildId, multiGuild });
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    process.exit(0);
  }
}

const bot = new TitanBot();
bot.start();

export default TitanBot;
