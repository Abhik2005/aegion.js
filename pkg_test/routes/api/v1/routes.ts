import { get } from '../../../../src/index.js';

export default get('/api/v1/status', (ctx) => {
    return {
        success: true,
        endpoint: '/api/v1/status',
        level: 'API Subdirectory (Level 2: /api/v1/)',
        status: 'Operational',
        timestamp: new Date().toISOString()
    };
});
