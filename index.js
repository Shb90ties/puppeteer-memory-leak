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
        

        const setupPageMethods = async function (page) {
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
                    count: 0,
                    /** @return Number, nearest multiple of numberOfPages, the loop must end in the last page */
                    getRelativeNumberOfChecks(targetAmount) {
                        let numberOfPages = window.puppeteerTools.checkAddress.length;
                        if (targetAmount < numberOfPages) {
                            return numberOfPages;
                        } else {
                            return Math.ceil(targetAmount/numberOfPages) * numberOfPages;
                        }
                    }
                };
            });
        };

        const getNewPage = async function(address, waitForSelectorToRender) {
            let newPage =  await browser.newPage();
            // close old one
            let pages = await browser.pages();
            pages[0].close();

            await freeze(200);
            await newPage.goto(address);
            await newPage.waitForSelector(waitForSelectorToRender);
            await newPage._client.send(`HeapProfiler.enable`);

            await setupPageMethods(newPage);

            return newPage;
        };

        let page = await getNewPage('http://localhost:3000/', '.center');

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

        const memoryLeakConsole = function (compName) {
            console.log('%c Memory Leak found in the ' + compName + ' Component', 'background-color: red; color: black');
        }

        /** Run through the pages in the checkAddress */
        const getNodeSamples = async function(page) {
            let NodeSamples = [];
            let times = await page.evaluate(() => {
                return window.puppeteerTools.getRelativeNumberOfChecks(5);
            });
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
            let searchData = {
                leaking: [],
                currentComp: 'Page',
                componentsStr: ''
            };

            searchData.componentsStr = await page.evaluate(() => {
                return window.puppeteerTools.getPageComponentsStr();
            });

            const keepSearching = function (searchData) {
                if (searchData.componentsStr === '') {
                    // sends another final loop
                    searchData.componentsStr = '-1';
                    return true;
                } else if (searchData.componentsStr === '-1') {
                    return false
                } else {
                    // check if there's still components that weren't checked
                    let arr = searchData.componentsStr.split(',');
                    for (let comp of arr) {
                        if (!searchData.leaking.includes(comp))
                            return true;
                    }
                }
                return false;
            };

            const shiftComponent = function (searchData) {
                searchData.componentsStr = searchData.componentsStr.split(',');
                searchData.currentComp = searchData.componentsStr.shift();

                // filter out duplicates
                const onlyUnique = (value, index, self) => { 
                    return self.indexOf(value) === index;
                };
                searchData.componentsStr = searchData.componentsStr.filter(onlyUnique);
                searchData.componentsStr = searchData.componentsStr.join(',');

                // add the known leakers so the test could continue without them
                let knownLeakers = searchData.leaking.join(',');
                if (knownLeakers !== '')
                    searchData.componentsStr = searchData.componentsStr + (searchData.componentsStr !== '' ? ',' : '') + knownLeakers;
            };

            while (keepSearching(searchData)) {
                page = await getNewPage(`http://localhost:3000/?disable-mem-leak-test=${searchData.componentsStr}`, '.center');

                await freeze(2000);

                samples = await getNodeSamples(page);
                hasLeak = hasMemoryLeak(samples);

                if (hasLeak) {
                    searchData.leaking.push(searchData.currentComp);
                } else {
                    shiftComponent(searchData);
                }
            }

            console.log('result ', searchData.leaking);
        }

        // browser.close();

    } catch(e) {
        console.log("Nooo! there's an ERROR....", e);
    }
})();