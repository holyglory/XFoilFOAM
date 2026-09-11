#include "fvCFD.H"
#include "functionObject.H"

using namespace Foam;

int main(int argc, char** argv)
{
    argList::noParallel();
    argList::addBoolOption("evolvingTurbulence", "Isolated must-reject turbulence fixture");
    argList::addBoolOption("primitiveFields", "Isolated pressure-solver field fixture");
    argList::addBoolOption("internalEnergy", "Isolated internal-energy field fixture");
    argList::addBoolOption("invalidFieldMode", "Isolated invalid field-mode fixture");
    argList::addBoolOption("invalidEnergyField", "Isolated invalid energy-field fixture");
    argList::addOption("changingField", "word", "Isolated must-reject changing field");
    #include "setRootCase.H"
    #include "createTime.H"
    #include "createMesh.H"
    const bool primitive = args.found("primitiveFields");
    const word energyName = args.found("invalidEnergyField") ? "invalid" : args.found("internalEnergy") ? "e" : "h";
    const word changing = args.getOrDefault<word>("changingField", word::null);
    volScalarField density(IOobject("rho", runTime.timeName(), mesh), mesh, dimensionedScalar("rho", dimDensity, 1));
    volVectorField momentum(IOobject("rhoU", runTime.timeName(), mesh), mesh, dimensionedVector("rhoU", dimDensity*dimVelocity, vector(1, 0, 0)));
    volScalarField energy(IOobject("rhoE", runTime.timeName(), mesh), mesh, dimensionedScalar("rhoE", dimPressure, 1));
    volVectorField velocity(IOobject("U", runTime.timeName(), mesh), mesh, dimensionedVector("U", dimVelocity, vector(1, 0, 0)));
    volScalarField specificEnergy(IOobject(energyName, runTime.timeName(), mesh), mesh, dimensionedScalar(energyName, sqr(dimVelocity), 2));
    volScalarField pressure(IOobject("p", runTime.timeName(), mesh), mesh, dimensionedScalar("p", dimPressure, 1));
    volScalarField turbulenceEnergy(IOobject("k", runTime.timeName(), mesh), mesh, dimensionedScalar("k", sqr(dimVelocity), 1));
    volScalarField turbulenceFrequency(IOobject("omega", runTime.timeName(), mesh), mesh, dimensionedScalar("omega", dimless/dimTime, 1));
    volScalarField reciprocalStep(IOobject("rDeltaT", runTime.timeName(), mesh), mesh, dimensionedScalar("rDeltaT", dimless/dimTime, 1));
    density.oldTime(); momentum.oldTime(); energy.oldTime(); turbulenceEnergy.oldTime(); turbulenceFrequency.oldTime();
    velocity.oldTime(); specificEnergy.oldTime(); pressure.oldTime();
    dictionary config;
    config.add("type", "xfoilfoamSteadyConvergence");
    config.add("referenceDensity", scalar(1));
    config.add("referenceSpeed", scalar(1));
    config.add("referenceLength", scalar(1));
    config.add("referenceSpecificEnergy", scalar(1));
    config.add("referenceTurbulenceEnergy", scalar(1));
    config.add("referenceTurbulenceFrequency", scalar(1));
    config.add("tolerance", scalar(1e-4));
    config.add("consecutiveSteps", label(100));
    config.add("conservedFields", word(args.found("invalidFieldMode") ? "invalid" : primitive ? "primitive" : "stored"));
    config.add("energyField", energyName);
    autoPtr<functionObject> detector = functionObject::New("nativeSteadyProbe", runTime, config);
    const bool evolving = args.found("evolvingTurbulence");
    for (label iteration = 1; iteration <= 100; ++iteration)
    {
        ++runTime;
        density.primitiveFieldRef() += changing == "rho" ? scalar(0.01) : scalar(0);
        momentum.primitiveFieldRef() += changing == "rhoU" ? vector(0.01, 0, 0) : vector::zero;
        energy.primitiveFieldRef() += changing == "rhoE" ? scalar(0.01) : scalar(0);
        velocity.primitiveFieldRef() += changing == "U" ? vector(0.01, 0, 0) : vector::zero;
        specificEnergy.primitiveFieldRef() += changing == "he" ? scalar(0.01) : scalar(0);
        pressure.primitiveFieldRef() += changing == "p" ? scalar(0.01) : scalar(0);
        turbulenceEnergy.primitiveFieldRef() += evolving || changing == "k" ? scalar(0.01) : scalar(0);
        turbulenceFrequency.primitiveFieldRef() += evolving || changing == "omega" ? scalar(0.01) : scalar(0);
        detector->execute();
    }
    return 0;
}
