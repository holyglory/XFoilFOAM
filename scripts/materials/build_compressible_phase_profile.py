"""Generate observational-only probes from exact authenticated OpenCFD 2606 files."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

SOURCE_SHA256 = {
    'EEqn.H': '85715aff4f27b95777ff47113cf49a88e90898756ee0f0cacb07ad22d72d5233',
    'Make/files': '03a6053dfb861a0e52c9dea214c0155cb8b5cf1df2a8512b88e8d40a2e04b5bb',
    'Make/options': '8d9713bd412d33fe035bd5b1fcdda23e78c1afbacd844f6653d55b0c4ff1aefe',
    'UEqn.H': '64eb9bd6ca63bc254fef0455e6d3c2ab3c4c745d57e7ae21d45a47244a970a8e',
    'correctPhi.H': 'c1e4e0fb3f9515357a751fa375ca8741583702c791137e335c27ae9e2042594a',
    'createFieldRefs.H': 'd81413d7a682adf6619cd6cd2b17c2fa26e88f9b98aef1ab054410055ad46e3d',
    'createFields.H': 'f2d5317f8fb8f5a992c2a237d2cca7bf4e794bff00f23b0a97e54e63356d35f8',
    'pEqn.H': '31fccc8a740bbaff3c4f5ee7913dd105a7759c92a136dd6685f1e82fd911b70a',
    'pcEqn.H': 'f4cdabe4b599dbdf6c496f50d72dcca18fa003d3e50e862b1b9e4dc4e315b14f',
    'rhoPimpleFoam.C': '05a3380efed79cc734838fec87a809d87d971427da7f50f2ae8017ce7b5714a8',
    'setRDeltaT.H': '6f62d2178a866e84f71ec4b0b9db82347fc6fb9d02d1ab16b1bc2f3ba0946572',
}
MARKER = ' // XFOILFOAM_PHASE_PROBE_V2'
CALIBRATION_CALLS = 100000


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def strip_probes(text):
    return ''.join(line for line in text.splitlines(keepends=True) if not line.rstrip().endswith(MARKER))


def instrument(name, original):
    if hashlib.sha256(original.encode()).hexdigest() != SOURCE_SHA256[name]:
        raise ValueError('Unauthenticated solver source: ' + name)
    text = original

    def insert(anchor, code, after=False, count=1):
        nonlocal text
        if text.count(anchor) != count:
            raise ValueError('Changed probe anchor: ' + anchor)
        code = code + MARKER + '\n'
        text = text.replace(anchor, anchor + code if after else code + anchor)

    def start(anchor, key, description, after=False, count=1):
        insert(anchor, f'addProfiling({key}, "phase.{description}");', after, count)

    def end(anchor, key, after=False, count=1):
        insert(anchor, f'endProfiling({key});', after, count)

    if name == 'rhoPimpleFoam.C':
        insert('#include "fvcSmooth.H"\n', '#include "profiling.H"', True)
        calibration = ('addProfiling(phaseCalibration, "phase.calibration.batch"); '
                       f'for (Foam::label phaseProbeIndex=0; phaseProbeIndex<{CALIBRATION_CALLS}; ++phaseProbeIndex) '
                       '{ addProfiling(phaseEmpty, "phase.calibration.empty"); } endProfiling(phaseCalibration);')
        insert('    #include "createTime.H"\n', calibration, True)
        start('        #include "readDyMControls.H"\n', 'phaseTimeControls', 'timeControls')
        end('        ++runTime;\n', 'phaseTimeControls', True)
        start('        Info<< "Time = " << runTime.timeName() << nl << endl;\n', 'phaseTimeLog', 'log.timeMarker')
        end('        Info<< "Time = " << runTime.timeName() << nl << endl;\n', 'phaseTimeLog', True)
        start('            if (pimple.firstIter() || moveMeshOuterCorrectors)\n', 'phaseMesh', 'meshAndMotion')
        end('            if (pimple.firstIter() && !pimple.SIMPLErho())\n', 'phaseMesh')
        start('                #include "rhoEqn.H"\n', 'phaseRhoInitial', 'rho.initial')
        end('                #include "rhoEqn.H"\n', 'phaseRhoInitial', True)
        start('                    #include "pcEqn.H"\n', 'phasePc', 'p.consistentBranch')
        end('                    #include "pcEqn.H"\n', 'phasePc', True)
        start('                turbulence->correct();\n', 'phaseTurbulence', 'turbulence')
        end('                turbulence->correct();\n', 'phaseTurbulence', True)
        start('        rho = thermo.rho();\n', 'phaseRhoFinal', 'rho.final')
        end('        rho = thermo.rho();\n', 'phaseRhoFinal', True)
        start('        runTime.write();\n', 'phaseFieldWrite', 'fullFieldWrite')
        end('        runTime.write();\n', 'phaseFieldWrite', True)
        start('        runTime.printExecutionTime(Info);\n', 'phaseExecutionLog', 'log.executionTime')
        end('        runTime.printExecutionTime(Info);\n', 'phaseExecutionLog', True)
    elif name == 'UEqn.H':
        start('MRF.correctBoundaryVelocity(U);\n', 'phaseUAssembly', 'U.assembly')
        end('if (pimple.momentumPredictor())\n', 'phaseUAssembly')
        start('    solve(UEqn == -fvc::grad(p));\n', 'phaseUPredictor', 'U.predictorCall')
        end('    solve(UEqn == -fvc::grad(p));\n', 'phaseUPredictor', True)
        start('    fvOptions.correct(U);\n', 'phaseUPost', 'U.post')
        end('    K = 0.5*magSqr(U);\n', 'phaseUPost', True)
    elif name == 'EEqn.H':
        start('    volScalarField& he = thermo.he();\n', 'phaseEAssembly', 'E.assembly')
        end('    EEqn.solve();\n', 'phaseEAssembly')
        start('    EEqn.solve();\n', 'phaseESolve', 'E.solveCall')
        end('    EEqn.solve();\n', 'phaseESolve', True)
        start('    fvOptions.correct(he);\n', 'phaseEPost', 'E.correctOptions')
        end('    fvOptions.correct(he);\n', 'phaseEPost', True)
        start('    thermo.correct();\n', 'phaseThermo', 'thermo.correct')
        end('    thermo.correct();\n', 'phaseThermo', True)
    elif name == 'pEqn.H':
        start('if (!pimple.SIMPLErho())\n', 'phasePPre', 'p.preAssembly')
        end('if (pimple.transonic())\n', 'phasePPre')
        start('    surfaceScalarField phid\n', 'phasePTransonic', 'p.transonicAssembly')
        # Both branch-local assembly scopes use the same variable name legally.
        start('    fvScalarMatrix pDDtEqn\n', 'phasePBase', 'p.baseMatrix', count=2)
        end('    while (pimple.correctNonOrthogonal())\n', 'phasePBase', count=2)
        end('    while (pimple.correctNonOrthogonal())\n', 'phasePTransonic', count=2)
        # The nontransonic branch has no phid scope. Remove its unmatched stop.
        first, second = text.split('\nelse\n', 1)
        second = second.replace('endProfiling(phasePTransonic);' + MARKER + '\n', '', 1)
        text = first + '\nelse\n' + second
        start('        fvScalarMatrix pEqn(pDDtEqn - fvm::laplacian(rhorAUf, p));\n', 'phasePMatrix', 'p.nonOrthogonalAssembly', count=2)
        end('        pEqn.solve(p.select(pimple.finalInnerIter()));\n', 'phasePMatrix', count=2)
        start('        pEqn.solve(p.select(pimple.finalInnerIter()));\n', 'phasePSolve', 'p.solveCall', count=2)
        end('        pEqn.solve(p.select(pimple.finalInnerIter()));\n', 'phasePSolve', True, count=2)
        start('        if (pimple.finalNonOrthogonalIter())\n', 'phasePFlux', 'p.fluxUpdate', count=2)
        # Stop at branch block exit without changing original object lifetimes.
        insert('            phi = phiHbyA + pEqn.flux();\n        }\n', 'endProfiling(phasePFlux);', True, count=2)
        start('p.relax();\n', 'phasePPost', 'p.postAndDensity')
        text += 'endProfiling(phasePPost);' + MARKER + '\n'
    if strip_probes(text) != original:
        raise ValueError('Probe removal does not restore exact upstream bytes')
    return text


def generate(source, destination, proof):
    if destination.exists() or proof.exists():
        raise ValueError('Versioned fresh build destinations required')
    destination.mkdir(parents=True)
    (proof / 'upstream').mkdir(parents=True)
    (proof / 'instrumented').mkdir()
    records, diff = {}, []
    for name, expected in SOURCE_SHA256.items():
        original = (source / name).read_text()
        if sha(source / name) != expected:
            raise ValueError('Source package member differs: ' + name)
        changed = instrument(name, original) if name.endswith(('.C', '.H')) else original
        if name == 'Make/files':
            changed = original.replace('$(FOAM_APPBIN)/rhoPimpleFoam', '$(FOAM_USER_APPBIN)/xfoilfoamRhoPimplePhaseProfile')
        for parent, content in [(destination, changed), (proof / 'upstream', original), (proof / 'instrumented', changed)]:
            file = parent / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        records[name] = {'upstreamSha256': expected, 'instrumentedSha256': sha(destination / name),
                         'exactAfterStrippingProbes': strip_probes(changed) == original if name.endswith(('.C', '.H')) else None}
        diff.extend(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile='upstream/' + name, tofile='instrumented/' + name))
    (proof / 'source.diff').write_text(''.join(diff))
    (proof / 'source-proof.json').write_text(json.dumps({'files': records, 'generatorSha256': sha(__file__),
        'calibrationCalls': CALIBRATION_CALLS, 'algorithmChanged': False, 'flagsChanged': False,
        'onlyNonProbeChange': 'Make/files output executable name/path'}, indent=2))


def build(source, destination, proof):
    generate(source, destination, proof)
    if os.environ.get('WM_OPTIONS') != 'linux64GccDPInt32Opt':
        raise ValueError('Expected original linux64GccDPInt32Opt compilation')
    original = Path(shutil.which('rhoPimpleFoam'))
    expected_original = '94e8a1a8f14f4e7dace8c3734302669441629f9b14f865fcb3485a4457658949'
    if sha(original) != expected_original:
        raise ValueError('Original native binary differs')
    with (proof / 'wmake.log').open('wb') as log:
        subprocess.run(['wmake', str(destination)], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    binary = Path(os.environ['FOAM_USER_APPBIN']) / 'xfoilfoamRhoPimplePhaseProfile'
    if sha(original) != expected_original:
        raise ValueError('Original binary was mutated')
    def capture(command):
        return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT)
    rules = Path(os.environ['WM_DIR']) / 'rules'
    rule_hashes = {str(p.relative_to(rules)): sha(p) for folder in ['linux64Gcc', 'General']
                   for p in (rules / folder).rglob('*') if p.is_file()}
    deps = capture(['ldd', str(binary)])
    dependency_files = {path: sha(path) for path in re.findall(r'=> (/\S+)', deps)}
    result = {'kind': 'experimental-instrumentation-only', 'originalBinarySha256': expected_original,
              'experimentalBinarySha256': sha(binary), 'experimentalBinaryBytes': binary.stat().st_size,
              'environment': {key: os.environ.get(key) for key in ['WM_OPTIONS','WM_COMPILER','WM_COMPILE_OPTION','WM_PRECISION_OPTION','WM_LABEL_SIZE','WM_PROJECT_VERSION']},
              'compiler': capture(['g++','--version']), 'originalCompilerComment': capture(['readelf','-p','.comment',str(original)]),
              'experimentalCompilerComment': capture(['readelf','-p','.comment',str(binary)]),
              'makeOptionsSha256': sha(destination / 'Make/options'), 'ruleHashes': rule_hashes,
              'dependencies': deps, 'dependencySha256': dependency_files, 'productionEvidence': False}
    (proof / 'build-proof.json').write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['generate', 'build'])
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--destination', type=Path, required=True)
    p.add_argument('--proof', type=Path, required=True)
    a = p.parse_args()
    (build if a.action == 'build' else generate)(a.source, a.destination, a.proof)
