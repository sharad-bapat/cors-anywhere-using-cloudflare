# CORS Anywhere Using Cloudflare Worker

## Cross-Origin Resource Sharing (CORS) Proxy
This Cloudflare Worker acts as a CORS proxy, enabling cross-origin resource sharing between web applications. It handles requests by fetching data from a specified URL, adding CORS headers, and returning the response to the original requester. The worker also sets a default user agent for the request.

## Setting up a CORS proxy worker on Cloudflare
This guide will show you how to set up a CORS proxy worker on Cloudflare using a pre-built script. This allows you to bypass CORS restrictions when making requests to external APIs or resources.

## Prerequisites

- A Cloudflare account
- Basic knowledge of Cloudflare Workers

## Steps
1. Login to your Cloudflare account and select the domain where you want to create the worker.
2. Open the Workers section and click on "Create a Worker".
3. Copy the code at the bottom of this file or copy it from the pre-built script [worker.js](https://github.com/sharad-bapat/cors-anywhere-using-cloudflare/blob/main/worker.js) available in this repository.
4. Replace the "https://example.com/" string in the code with the URL of the external API or resource you want to make requests to.
5. Save the worker and deploy it to your domain.
6. Test the worker by sending a request to the proxy URL in the format https://<your_domain>/<your_worker_path>?url=<external_resource_url>.

## Notes
- This CORS proxy worker is meant for personal and educational use only. Use at your own risk.
- The worker is not optimized for high-traffic production environments.
- For more information on Cloudflare Workers, see the official documentation.    
- For more information on CORS, see the MDN web docs.
    
## Deploy on CLoudflare
[![Cloudflare CORS Proxy Worker](https://img.shields.io/badge/Cloudflare-CORS%20Proxy%20Worker-5e5e5e.svg?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Code

```js
    {
    addEventListener('fetch', event => {
      event.respondWith(handleRequest(event.request))
    })

    async function handleRequest(request) {
      const url = new URL(request.url);
      const corsUrl = url.searchParams.get('url');

      if (!corsUrl) {
        return new Response('Missing URL parametersss', { status: 400 });
      }

      const corsHeaders = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
      });

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders,
        });
      }

      const corsRequest = new Request(corsUrl, {
        headers: request.headers,
        method: request.method,
        body: request.body,
        redirect: 'follow',
      });

      const corsResponse = await fetch(corsRequest);
      const response = new Response(corsResponse.body, corsResponse);
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', '*');
      response.headers.set('Access-Control-Expose-Headers', '*');
      return response;
    }
```
