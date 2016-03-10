import * as g from './generator';
import * as tsa from './tsAnalyzer';
import * as tsch from './tsCompilerHost';
import * as log from './logger';
import * as nameUnifier from './nameUnifier';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as pathPlatformDependent from 'path';

const path = pathPlatformDependent.posix; // This works everythere, just use forward slashes

var defaultLibFilename = path.join(path.dirname(require.resolve("typescript").replace(/\\/g, '/')), "lib.es6.d.ts");

export default (project: g.IGenerationProject, tsAnalyzer: tsa.ITsAnalyzer, logger: log.ILogger, rootStateKey: string = null): g.IGenerationProcess => {
    return {
        run: () => runBase(false, project, tsAnalyzer, logger, rootStateKey),
        runRecurse: () => runBase(true, project, tsAnalyzer, logger, rootStateKey)
    }
}

function runBase(applyRecurse: boolean, project: g.IGenerationProject, tsAnalyzer: tsa.ITsAnalyzer, logger: log.ILogger, rootStateKey: string): Promise<any> {
    const writeCallback = (fn, c) => { project.writeFileCallback(fn, new Buffer(c, 'utf-8')); }
    function writeCursors(params: g.ILoadedParams, currentStateName: string, rootStateKey: string) {
        let stateFilePath = params.stateFilePath;
        let mainState = g.resolveState(params.data.states, currentStateName);
        if (!mainState)
            return;
        const stateAlias = g.createUnusedAlias(g.stateImportKey, params.data.imports);
        const bobfluxPrefix = g.resolveBobfluxPrefix(mainState);
        logger.info('Generating has been started for: ', stateFilePath);
        writeCallback(
            createCursorsFilePath(stateFilePath),
            g.createFullImports(stateAlias, `./${params.data.fileName}`, params.data.imports)
            + createRootKey(rootStateKey, bobfluxPrefix)
            + createRootCursor(rootStateKey, bobfluxPrefix, stateAlias, mainState.typeName)
            + createCursorsForStateFields(params, rootStateKey, params.data, mainState, bobfluxPrefix, stateAlias)
        );
        logger.info('Generating ended for: ', stateFilePath);
    }
    function createCursorsForStateFields(params: g.ILoadedParams, parentStateKey: string, data: tsa.IStateSourceData, state: tsa.IStateData, bobfluxPrefix: string, stateAlias: string, prefix: string = null): string {
        let nexts: INextIteration[] = [];
        let inner = state.fields.map(f => {
            let key = parentStateKey === null ? g.composeCursorKey(parentStateKey, prefix, f.name) : g.composeCursorKey(prefix, f.name);
            let fieldType = f.isArray ? `${f.type}[]` : f.type;
            if (applyRecurse && g.isExternalState(fieldType)) {
                let typeParts = fieldType.split('.');
                let foundImport = g.findImportAlias(data.imports, typeParts[0]);
                if (foundImport === null)
                    return '';
                let innerFilePath = path.join(path.dirname(params.stateFilePath), data.imports.filter(i => i.prefix === typeParts[0])[0].relativePath + '.ts');
                let innerSourceFile = g.resolveSourceFile(params.sourceFiles, innerFilePath);
                if (innerSourceFile) {
                    let innerData = tsAnalyzer.getSourceData(innerSourceFile, params.typeChecker);
                    let innerResolvedState = g.resolveState(innerData.states, typeParts[1]);
                    if (innerResolvedState)
                        if (g.isRouteComponentState(...innerResolvedState.heritages))
                            writeCursors({
                                stateFilePath: innerSourceFile.path,
                                data: tsAnalyzer.getSourceData(innerSourceFile, params.typeChecker),
                                sourceFiles: params.sourceFiles,
                                typeChecker: params.typeChecker
                            }, typeParts[1], g.composeCursorKey(parentStateKey, key));
                        else if (g.isComponentState(...innerResolvedState.heritages))
                            nexts.push({ state: innerResolvedState, prefix: key });
                }
            }
            let states = data.states.filter(s => s.typeName === f.type);
            if (states.length > 0)
                fieldType = `${stateAlias}.${fieldType}`;
            if (f.isArray)
                return createFieldCursor(prefix, key, f.name, bobfluxPrefix, fieldType, parentStateKey !== null);
            if (states.length > 0)
                nexts.push({ state: states[0], prefix: key });
            if (states.length > 1)
                throw 'Two states with same name could not be parsed. It\'s compilation error.';
            if (g.isFieldEnumType(fieldType, data.enums))
                fieldType = `${stateAlias}.${fieldType}`;
            return createFieldCursor(prefix, key, f.name, bobfluxPrefix, fieldType, parentStateKey !== null);
        }).join('\n');
        return inner + (nexts.length > 0 ? '\n' : '') + nexts.map(n => createCursorsForStateFields(params, parentStateKey, data, n.state, bobfluxPrefix, stateAlias, n.prefix)).join('\n');
    }
    return new Promise((f, r) => {
        g.loadSourceFiles(project, tsAnalyzer, logger)
            .then(p => {
                try {
                    writeCursors(p, project.appStateName, rootStateKey);
                } catch (e) {
                    logger.error('Error on cursors writing.', e);
                }
                f();
            })
            .catch(e => r(e));
    })
}

function createRootKey(key: string, bobfluxPrefix: string): string {
    return `export const rootKey = ${key ? `'${key}'` : `${bobfluxPrefix}.rootCursor.key`};

`;
}

function createFieldCursor(prefix: string, key: string, fieldName: string, bobfluxPrefix: string, typeName: string, withRoot: boolean): string {
    return `export const ${prefix === null ? fieldName : nameUnifier.getStatePrefixFromKeyPrefix(prefix, fieldName)}Cursor: ${bobfluxPrefix}.ICursor<${typeName}> = {
    key: ${withRoot ? `rootKey + '.${key}'` : `'${key}'`}
}
`;
}


function createRootCursor(key: string, bobfluxPrefix: string, stateAlias: string, typeName: string): string {
    return key
        ? `export const rootCursor: ${bobfluxPrefix}.ICursor<${stateAlias}.${typeName}> = {
    key: rootKey
}

`
        : `export const rootCursor: ${bobfluxPrefix}.ICursor<${stateAlias}.${typeName}> = ${bobfluxPrefix}.rootCursor

`;
}

export function createCursorsFilePath(stateFilePath: string): string {
    return `${path.join(path.dirname(stateFilePath), path.basename(stateFilePath).replace(path.extname(stateFilePath), ''))}.cursors.ts`;
}

interface INextIteration {
    state: tsa.IStateData
    prefix: string
}

interface IExternalChildState {
    state: string
    import: tsa.IImportData
    prefix: string
    parentFullPath: string
}
