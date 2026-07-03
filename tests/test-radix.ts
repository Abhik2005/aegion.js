import { Router } from '../src/router';
import { get } from '../src/composition';

const router = new Router();

let deepPath = '/api/deep';
for (let i = 0; i < 100; i++) {
    deepPath += `/:param${i}`;
}

const routeDef = get(deepPath, async () => {});
router.add('GET', deepPath, routeDef as any);

let deepUrl = '/api/deep' + '/a'.repeat(100);

console.log("Searching for:", deepUrl);
const result = router.find('GET', deepUrl);
console.log("Result:", result ? "Found" : "Not Found");
