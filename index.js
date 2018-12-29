const puppeteer = require('puppeteer');

const freeze = function (miliseconds) {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(true);
        }, miliseconds);
    })
};

(async function main() {
    try {
        const browser = await puppeteer.launch({
            headless: false,
            dumpio: true,
            defaultViewport: {
                width: 1600,
                height: 800
            },
            devtools: false,
            args: ['--sampling-heap-profiler']
        });

        const page = await browser.newPage();

        // close the blank page
        let pages = await browser.pages();
        pages[0].close();

        await freeze(500);
        
        await page.goto('http://localhost:3000/');
        await page.waitForSelector('.the_button');
        await page._client.send(`HeapProfiler.enable`);

        await freeze(500);

        // setup methods in browser
        await page.evaluate(() => {
            window.puppeteerTools = {
                getComponent(compName) {

                },
                getPageComponent() {

                },
                getComponentChildrens(compName) {

                },
                checkAddress: ['/test', '/'],
                count: 0
            };
        });

        /** Run through the pages in the checkAddress */
        const getNodeSamples = async function(page) {
            let NodeSamples = [];
            let times = 30;
            // reset former counters
            await page.evaluate(() => {
                window.puppeteerTools.count = 0;
            });
            // browse through the pages
            for (let i = 0; i < times; i++) {
                await page._client.send(`HeapProfiler.collectGarbage`);
                let startMetrics = await page.metrics();
                console.log('startMetrics: ', startMetrics.Nodes);


                await page.evaluate(() => {
                    window.vue.$router.push(window.puppeteerTools.checkAddress[window.puppeteerTools.count % window.puppeteerTools.checkAddress.length]);
                    window.puppeteerTools.count++;
                });
                await freeze(2000);
            }
        };

        await getNodeSamples(page);

        // browser.close();

    } catch(e) {
        console.log("Nooo! there's an ERROR....", e);
    }
})();