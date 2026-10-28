# Deploy

The hosting platform injects `PLATFORM_URL`. Read it in your code:

```js
const url = new URL(`https://${process.env["PLATFORM_URL"]}`);
```
