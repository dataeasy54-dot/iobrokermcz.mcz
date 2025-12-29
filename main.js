const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const WebSocket = require('ws');

class MczAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'mcz' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    async onReady() {
        this.log.info('MCZ Adapter startet');

        if (!this.config.email || !this.config.password) {
            this.log.error('Bitte E-Mail und Passwort im Adapter setzen');
            return;
        }

        try {
            this.token = await this.loginCloud();
            this.device = await this.getDevice();
            this.log.info(`Gerät gefunden: ${this.device.model} @ ${this.device.localIp}`);

            await this.createStates();
            this.connectWebSocket(this.device.localIp);

            this.pollTimer = setInterval(
                () => this.requestStatus(),
                (this.config.interval || 10) * 1000
            );

        } catch (e) {
            this.log.error(`Startfehler: ${e.message}`);
        }
    }

    async loginCloud() {
        const res = await axios.post(
            'https://api.mczgroup.it/v1/auth/login',
            {
                email: this.config.email,
                password: this.config.password
            }
        );
        return res.data.access_token;
    }

    async getDevice() {
        const res = await axios.get(
            'https://api.mczgroup.it/v1/devices',
            { headers: { Authorization: `Bearer ${this.token}` } }
        );
        return res.data[0]; // erstes Gerät
    }

    connectWebSocket(ip) {
        this.ws = new WebSocket(`ws://${ip}:81`);

        this.ws.on('open', () => {
            this.log.info('WebSocket verbunden');
            this.requestStatus();
        });

        this.ws.on('message', msg => {
            const data = JSON.parse(msg.toString());
            this.updateStates(data);
        });

        this.ws.on('close', () => {
            this.log.warn('WebSocket getrennt – Reconnect in 10s');
            setTimeout(() => this.connectWebSocket(ip), 10000);
        });
    }

    requestStatus() {
        if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'GET', data: 'STATUS' }));
        }
    }

    async createStates() {
        const states = {
            'status.power': { type: 'boolean', role: 'switch.power' },
            'status.roomTemp': { type: 'number', role: 'value.temperature' },
            'status.targetTemp': { type: 'number', role: 'level.temperature' },
            'status.mode': { type: 'string', role: 'text' },
            'control.targetTemp': { type: 'number', role: 'level.temperature', write: true }
        };

        for (const id in states) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: {
                    name: id,
                    type: states[id].type,
                    role: states[id].role,
                    read: true,
                    write: !!states[id].write
                },
                native: {}
            });
        }
    }

    async updateStates(data) {
        if (data.room_temperature !== undefined)
            this.setState('status.roomTemp', data.room_temperature, true);

        if (data.target_temperature !== undefined)
            this.setState('status.targetTemp', data.target_temperature, true);

        if (data.power !== undefined)
            this.setState('status.power', !!data.power, true);

        if (data.mode)
            this.setState('status.mode', data.mode, true);
    }

    onStateChange(id, state) {
        if (!state || state.ack) return;

        if (id.endsWith('control.targetTemp')) {
            this.ws.send(JSON.stringify({
                type: 'SET',
                data: { target_temperature: state.val }
            }));
        }
    }
}

module.exports = options => new MczAdapter(options);
