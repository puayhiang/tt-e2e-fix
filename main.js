const { Octokit } = require("@octokit/core");
const authToken = require("./config").authToken
const fs = require('fs');
var extract = require('extract-zip')

// Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
const octokit = new Octokit({ auth: authToken });
const currentDirectory = process.cwd();

const responseErrorCheck = (response) => {
    // Informational responses (100–199)
    // Successful responses (200–299)
    // Redirection messages (300–399)
    // Client error responses (400–499)
    // Server error responses (500–599)
    if(response.status >= 400){
        throw new Error(`Error with Status Code: ${response.status}`)
    }
}

const writeJSONToFile = (fileName, jsonData) => {
  let jsonString = jsonData
  if(typeof jsonData !== 'string')
    jsonString = JSON.stringify(jsonData)
    fs.writeFileSync(fileName, jsonString);
}

const readJSONFromFile = (fileName) => {
    const fileData = fs.readFileSync(fileName);
    const jsonData = JSON.parse(fileData)
    return jsonData;
}

const copyFile = (fileName, destinationFileName) => {
  if(fs.existsSync(fileName)){
    fs.copyFileSync(fileName, destinationFileName);
  }else{
    throw new Error(`${fileName} does not exist`);
  }
}

const createDir = (folderName) => {
  if(!fs.existsSync(folderName)){
    fs.mkdirSync(folderName, { recursive: true })
  }
}

const retrieveJobsList = async () => {
    let jobsList = []
    complete = false
    currentPage = 1
    totalPage = -1;
    jobsPerPage = 100 // 100 is Max
    do{
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
            owner: 'tradetrust',
            repo: 'tradetrust-website',
            branch: 'master',
            status: 'completed',
            per_page: jobsPerPage,
            page: currentPage
        })
        responseErrorCheck(response)
        const retrievedData = response.data;
        totalPage = retrievedData.total_count;
        if((currentPage * jobsPerPage) >= totalPage){
            complete = true;
        }
        currentPage = currentPage + 1
        jobsList = jobsList.concat(retrievedData.workflow_runs)
    }while(!complete)

    const JSONdata = {
        total_count: jobsList.length,
        workflow_runs: jobsList
    }

    writeJSONToFile("jobs.json", JSONdata);
    return JSONdata;
}

const getFailedJobsList = () => {
    const jobsData = readJSONFromFile("jobs.json")
    const failedJobsList = jobsData.workflow_runs.filter((data) => {
        return data.conclusion === "failure";
    })
    return failedJobsList;
}

const getFailedJobsLogsURL = (jobsData) => {
    const failedJobsUrlList = jobsData.map((data) => {
        // return data.logs_url;
        return data.id;
    })
    return failedJobsUrlList;
}



const saveLogs = async (runId) => {
    parameters = {
        owner: 'tradetrust',
        repo: 'tradetrust-website',
        run_id: runId,
    }
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs', parameters)
    responseErrorCheck(response)
    createDir('logs')
    fs.writeFileSync(`logs/${runId}.zip`, Buffer.from(response.data));
    return {zipFileRelativePath: `logs/${runId}.zip`, runId: runId, zipFileName: `${runId}.zip`};
}

const syncSaveAllLogs = async (failedRunsId) => {
    const runPromises = failedRunsId.map((runId) => {
        return saveLogs(runId);
    })
    const status = await Promise.allSettled(runPromises);
    const runResults = status.filter((runStatus) => {
        return runStatus.status === 'fulfilled'
    }).map((runStatus) => {
        return runStatus.value;
    });
    return runResults;
}


const unzipAll = async (fileList) => {
  
  const runPromises = fileList.map((runData) => {
      const { zipFileRelativePath, runId } = runData;
      return extract(zipFileRelativePath, { dir: `${currentDirectory}/unzipped/${runId}` })
  })
  await Promise.allSettled(runPromises);
  const returnStatus = fileList.map((runData) => {
    const { runId } = runData;
    return {
      ...runData,
      unzippedRelativeDir: `unzipped/${runId}`
    };
  });
  return returnStatus;
}

const retrieveErrorMessage = (fileName, startCharacterLine, endCharacterLine, subtractEnding) => {
  const fileLines = fs.readFileSync(fileName,{encoding:'utf8', flag:'r'}).split(/\r?\n/);
  const errorLineNumber = []
  const successLineNumber = []
  for(var i = 0; i < fileLines.length; i++){
    const currentLine = fileLines[i]
    if(currentLine.indexOf(startCharacterLine) !== -1){
      errorLineNumber.push(i)
    }
    if(currentLine.indexOf(endCharacterLine) !== -1){
      successLineNumber.push(i);
    }
  }

  //sowie
  let fileSymbols = [...errorLineNumber, ...successLineNumber];
  fileSymbols = fileSymbols.sort((a,b) => a-b);

  let successStartPos = 0;
  const errorDictionary = {}
  
  for(var i = 0; i < errorLineNumber.length; i++){
    const startLineNumber = errorLineNumber[i];
    for(var j = successStartPos; j < fileSymbols.length; j++){
      if(fileSymbols[j] <= startLineNumber){ 
        continue; 
      }else {
        errorDictionary[startLineNumber] = fileSymbols[j] + subtractEnding
        successStartPos = j;
        break;
      }
    }
  }

  for (const [key, value] of Object.entries(errorDictionary)) {
    const startPos = key;
    const endPos = value;
    let lineArray = []
    for(var i = key - 1; i < endPos; i++){
      const infoStart = fileLines[i].indexOf("Z ");
      const cutLine = fileLines[i].substring(infoStart + 3,fileLines[i].length)
      lineArray = lineArray.concat(cutLine)
    }
    // const testModuleName = lineArray[1].trim() === '' ? lineArray[0] : lineArray[0] + ' ' + lineArray[1].trim()
    const testName = lineArray[2].trim() === '' ? lineArray[1] : lineArray[1] + ' ' + lineArray[2].trim()
    errorDictionary[key] = {
      testModule: lineArray[0],
      testName: testName,
      endPos: value,
      lines: lineArray
    }
  }
  return errorDictionary;
}

const copyOutTestCafeLogs = (fileList) => {
  
  const returnStatus = fileList.map((fileDir) => {
    const sourceFile = `${fileDir.unzippedRelativeDir}/Lint & Test/10_Integration - testcafe.txt`
    const destFile = `${currentDirectory}/TestCafeLogs/${fileDir.runId}.txt`
    createDir('TestCafeLogs')
    try{
      copyFile(sourceFile,destFile)
    }catch(e){
      console.error(e)
    }
    return {
      ...fileDir,
      testCafeLog: `TestCafeLogs/${fileDir.runId}.txt`
    }
  });
  return returnStatus;
}

const collateErrorMessages = (testCafeLogs, startCharacterLine, endCharacterLine, subtractEnding) => {
  
  const errorDict = {}
  // {
  //   zipFileRelativePath: 'logs/1968028998.zip',
  //   runId: 1968028998,
  //   zipFileName: '1968028998.zip',
  //   unzippedDir: 'unzipped/1968028998',
  //   testCafeLog: 'TestCafeLogs/1968028998.txt'
  // },

  testCafeLogs.map((testCafeLog) => {
    const runId = testCafeLog.runId;
    const logPath = testCafeLog.testCafeLog;
    const retrieved = retrieveErrorMessage(logPath,startCharacterLine, endCharacterLine, subtractEnding);

    for (const [key, value] of Object.entries(retrieved)) {
      const {testModule, testName, endPos, lines} = value;
      errorDict[testModule] = typeof errorDict[testModule] === "undefined" ? {} : errorDict[testModule];
      errorDict[testModule][testName] = typeof errorDict[testModule][testName] === "undefined" ? [] : errorDict[testModule][testName];
      // errorDict[testModule][testName][runId] = typeof errorDict[testModule][testName] === "undefined" ? [] : errorDict[testModule][testName];
      errorDict[testModule][testName].push({
        startPos: key,
        endPos: endPos,
        lines: lines,
        runId: runId
      })
    }
  })
  return errorDict;
}

async function collective (){

    retrieveJobsList();
    const failedJobList = await getFailedJobsList()
    const failedRunsId = await getFailedJobsLogsURL(failedJobList);
    
    const runList = await syncSaveAllLogs(failedRunsId);
    const unzippedFolders = await unzipAll(runList)
    const testCafeLogs = await copyOutTestCafeLogs(unzippedFolders)
    const errorList = await collateErrorMessages(testCafeLogs,"✖", "✓",-1)
    createDir("final")
    writeJSONToFile("final/errors.json", JSON.stringify(errorList, null, "\t"))
}

collective();