import { get } from '../../src/index.js';

export default get('/', (ctx) => {
    return {
        success: true,
        endpoint: '/',
        level: 'Root Level (Level 0)',
        message: 'Hello from root routes.ts!'
    };
});
