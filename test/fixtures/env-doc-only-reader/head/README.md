# Lib

This library never reads env itself.
Pass `MY_SERVICE_TOKEN` from your app.

```js
const lib = create({ token: getSecret() });
```
