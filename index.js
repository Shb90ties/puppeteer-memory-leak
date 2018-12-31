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
                            output = compName.replace(/-([a-z])/g, function (g) { return g[1].toUpperCase(); });
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
                    getComponentsStr(compName) {
                        let output = [];
                        let cName = window.puppeteerTools.getComponentHtmlName(compName);
                        let mainComp =  window.puppeteerTools.getComponent(cName, vue);
                        if (mainComp && mainComp.$children && mainComp.$children[0]) {
                            let component = compName === 'nuxt' ? mainComp.$children[0] : mainComp;
                            let childComps = (component.$children && component.$children.length) ? component.$children : [];
                            for (let child of childComps) {
                                let name = (child.$options._componentTag) ? child.$options._componentTag : window.puppeteerTools.getComponentDashedName(child._name);
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


        // Create a Map object
        await page.evaluate(() => window.map = new window.myVue());
        // Get a handle to the Map object prototype
        const mapPrototype = await page.evaluateHandle(() => window.myVue.prototype);
        // Query all map instances into an array
        const mapInstances = await page.queryObjects(mapPrototype);
        console.log('mapInstances: ', mapInstances);
        // Count amount of map objects in heap
        const count = await page.evaluate(maps => maps.length, mapInstances);
        console.log('count: ', count);
        await mapInstances.dispose();
        await mapPrototype.dispose();


        return;

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

        // let samples = [];
        // let hasLeak = true; 

        if (hasLeak) {
            const searchOnComp = async function (compName, alwaysOff = []) {
                let rootComponent = compName;

                let searchData = {
                    turnOff: alwaysOff,
                    leaking: [],
                    currentComp: compName,
                    componentsStr: '',
                    onlyContainers: [],
                    childLeakers: []
                };
                
                console.log('the root Component that is being check ', compName);
                
                searchData.componentsStr = await page.evaluate((cmpName) => {
                    return window.puppeteerTools.getComponentsStr(cmpName);
                }, compName);


                const onlyUnique = (value, index, self) => { 
                    return self.indexOf(value) === index;
                };
                let arr = searchData.componentsStr.split(',');
                arr = arr.filter(onlyUnique);
                // push the always off to the end of the string
                for (let comp of alwaysOff) {
                    let index = arr.indexOf(comp);
                    if (index !== -1) {
                        arr.splice(index, 1);
                    }
                }
                searchData.componentsStr = arr.join(',');
                if (alwaysOff.length)
                    searchData.componentsStr = searchData.componentsStr + (searchData.componentsStr !== '' ? ',' : '') + alwaysOff.join(',');
                let startingComps = searchData.componentsStr.split(',');
                console.log('Components to Check:: ', searchData.componentsStr);


                const keepSearching = function (searchData) {
                    let arr = searchData.componentsStr.split(',');
                    if (searchData.turnOff.includes(searchData.currentComp)) {
                        return false;
                    }
                    if (!searchData.leaking.includes(searchData.currentComp)) {
                        return true;
                    }
                    if (searchData.componentsStr === '') {
                        searchData.componentsStr = '-1';
                        return true;
                    }
                    return false;
                };

                const shiftComponent = function (searchData) {
                    searchData.componentsStr = searchData.componentsStr.split(',');
                    searchData.currentComp = searchData.componentsStr.shift();
                    searchData.componentsStr = searchData.componentsStr.join(',');

                    // add the known leakers so the test could continue without them
                    let knownLeakers = searchData.leaking.join(',');
                    if (knownLeakers !== '')
                        searchData.componentsStr = searchData.componentsStr + (searchData.componentsStr !== '' ? ',' : '') + knownLeakers;
                };

                while (keepSearching(searchData)) {
                    console.log('Checking Component ' + searchData.currentComp);
                    let url = `http://localhost:3000/?disable-mem-leak-test=${searchData.componentsStr}`;
                    page = await getNewPage(url, '.center');

                    samples = await getNodeSamples(page);
                    hasLeak = hasMemoryLeak(samples);

                    if (hasLeak) {
                        searchData.leaking.push(searchData.currentComp);
                        if (rootComponent === searchData.currentComp)
                            return [rootComponent];
                    }
                    shiftComponent(searchData);
                }

                for (let leaker of searchData.leaking) {
                    let alwaysOff = JSON.parse(JSON.stringify(searchData.turnOff));
                    for (let comp of startingComps) {
                        if (comp && leaker !== comp && !alwaysOff.includes(comp)) {
                            alwaysOff.push(comp)
                        }
                    }
                    let leakerI = alwaysOff.indexOf(leaker);
                    if (leakerI !== -1) {
                        alwaysOff.splice(leakerI, 1);
                    }
                    console.log('_____>> Dive to >>> ' + leaker, 'off:: ' + alwaysOff.join(','));

                    let newUrl = `http://localhost:3000/?disable-mem-leak-test=${alwaysOff.join(',')}`;
                    page = await getNewPage(newUrl, '.center');

                    let res = await searchOnComp(leaker, alwaysOff);
                    console.log('!!!!! the res: ' + leaker, res);
                    if (res.indexOf(leaker) === -1) {
                        searchData.onlyContainers.push(leaker);
                    }
                    // add results to output
                    for (let leakC of res) {
                        if (searchData.childLeakers.indexOf(leakC) === -1) {
                            searchData.childLeakers.push(leakC);
                        }
                    }
                }

                // add child leakers
                for (let cmp of searchData.childLeakers) {
                    let i = searchData.leaking.indexOf(cmp);
                    if (i === -1) {
                        searchData.leaking.push(cmp);
                    }
                }

                // remove components that only contained leakers
                for (let cmp of searchData.onlyContainers) {
                    let i = searchData.leaking.indexOf(cmp);
                    if (i !== -1) {
                        searchData.leaking.splice(i, 1);
                    }
                }

                console.log('RETURN ', searchData.leaking);

                return searchData.leaking;
            }

            let data = await searchOnComp('nuxt');

            console.log('!!!!!! result !!!!!!', data);
        }

        // browser.close();

    } catch(e) {
        console.log("Nooo! there's an ERROR....", e);
    }
})();