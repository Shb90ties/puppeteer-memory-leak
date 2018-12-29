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
                /** @return 'page-link' for '<PageLink>' */
                getComponentDashedName(compName) {
                    let output = '';
                    if (typeof compName === 'string') {
                        output = compName.replace(/<|>|-/g, '');
                        output = output.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
                    }
                    return output;
                },
                /** @return '<PageLink>' for 'page-link' */
                getComponentHtmlName(compName) {
                    let output = '';
                    if (typeof compName === 'string') {
                        output = output.replace(/-([a-z])/g, function (g) { return g[1].toUpperCase(); });
                        output = output.charAt(0).toUpperCase() + output.slice(1);
                        output = `<${output}>`;
                    }
                    return output;
                },
                getComponent(compName, comp) {
                    if (compName === comp._name) {
                        return comp;
                    } else if (comp.$children && comp.$children.length) {
                        for (let child of comp.$children) {
                            let resComp = window.puppeteerTools.getComponent(compName, child);
                            if (resComp) {
                                return resComp;
                            }
                        }
                    }
                    return null;
                },
                getPageComponentsStr() {
                    let output = [];
                    let mainComp =  window.puppeteerTools.getComponent('<Nuxt>', vue);
                    if (mainComp && mainComp.$children && mainComp.$children[0]) {
                        let page = mainComp.$children[0];
                        let childComps = (page.$children && page.$children.length) ? page.$children : [];
                        for (let child of childComps) {
                            let name = window.puppeteerTools.getComponentDashedName(child._name);
                            if (name) {
                                output.push(name);
                            }
                        }
                    }
                    return output.join(',');
                },
                checkAddress: ['/test', '/'],
                count: 0
            };
        });

        const hasMemoryLeak = function(sampleNodes) {
            let risesCount = 0;
            for (let i=1; i<sampleNodes.length; i++) {
                let wasRised = true;
                for (let j=(i-1); j>=0; j--) {
                    if (sampleNodes[j] >= sampleNodes[i]) {
                        wasRised = false; break;
                    }
                }
                if (wasRised) {
                    risesCount++;
                }
            }
            return (risesCount/sampleNodes.length > 0.4);
        };

        /** Run through the pages in the checkAddress */
        const getNodeSamples = async function(page) {
            let NodeSamples = [];
            let times = 20;
            // reset former counters
            await page.evaluate(() => {
                window.puppeteerTools.count = 0;
            });
            // browse through the pages
            for (let i = 0; i < times; i++) {
                await page._client.send(`HeapProfiler.collectGarbage`);
                let startMetrics = await page.metrics();
                NodeSamples.push(startMetrics.Nodes);

                await page.evaluate(() => {
                    window.vue.$router.push(window.puppeteerTools.checkAddress[window.puppeteerTools.count % window.puppeteerTools.checkAddress.length]);
                    window.puppeteerTools.count++;
                });
                await freeze(1000);
            }
            return NodeSamples;
        };

        let samples = await getNodeSamples(page);
        let hasLeak = hasMemoryLeak(samples);

        if (hasLeak) {
            
        }

        // browser.close();

    } catch(e) {
        console.log("Nooo! there's an ERROR....", e);
    }
})();