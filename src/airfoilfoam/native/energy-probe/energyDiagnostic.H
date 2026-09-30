#include <cmath>
#include <iomanip>
#include <iostream>

void reportEnergyBalance
(
    const Foam::Time& clock,
    const Foam::fvMesh& mesh,
    const Foam::scalarField& densityBefore,
    const Foam::scalarField& energyBefore,
    const Foam::vectorField& velocityBefore,
    const Foam::vectorField& inviscidVelocity,
    const Foam::volScalarField& density,
    const Foam::volScalarField& totalEnergy,
    const Foam::volVectorField& velocity,
    const Foam::volScalarField& internalEnergy,
    const Foam::surfaceScalarField& massFlux,
    const Foam::surfaceScalarField& energyFlux,
    const Foam::surfaceScalarField& viscousWork
)
{
    const Foam::label cell = Foam::findMin(internalEnergy.primitiveField());
    const Foam::volScalarField massDivergence(Foam::fvc::div(massFlux));
    const Foam::volScalarField energyDivergence(Foam::fvc::div(energyFlux));
    const Foam::volScalarField workDivergence(Foam::fvc::div(viscousWork));
    const Foam::scalar step = clock.deltaTValue();
    const Foam::scalar convectedEnergy = energyBefore[cell] - step*energyDivergence[cell];
    const Foam::scalar kineticBefore = 0.5*Foam::magSqr(velocityBefore[cell]);
    const Foam::scalar kineticInviscid = 0.5*Foam::magSqr(inviscidVelocity[cell]);
    const Foam::scalar kineticAfter = 0.5*Foam::magSqr(velocity[cell]);
    std::cout << std::setprecision(17) << "XFOILFOAM_ENERGY_BALANCE {\"cell\":" << cell;
    auto scalarEntry = [](const char* name, Foam::scalar value)
    {
        std::cout << ",\"" << name << "\":";
        if (std::isfinite(value)) std::cout << value;
        else std::cout << "null";
    };
    scalarEntry("time", clock.value());
    scalarEntry("delta_t", step);
    scalarEntry("x", mesh.C()[cell].x());
    scalarEntry("y", mesh.C()[cell].y());
    scalarEntry("density_before", densityBefore[cell]);
    scalarEntry("density_after", density[cell]);
    scalarEntry("density_balance_error", density[cell] - densityBefore[cell] + step*massDivergence[cell]);
    scalarEntry("total_energy_before", energyBefore[cell]);
    scalarEntry("total_energy_after", totalEnergy[cell]);
    scalarEntry("convective_energy_change", -step*energyDivergence[cell]);
    scalarEntry("viscous_energy_change", step*workDivergence[cell]);
    scalarEntry("energy_balance_error", totalEnergy[cell] - convectedEnergy - step*workDivergence[cell]);
    scalarEntry("kinetic_before", kineticBefore);
    scalarEntry("kinetic_inviscid", kineticInviscid);
    scalarEntry("kinetic_after", kineticAfter);
    scalarEntry("internal_energy_before", energyBefore[cell]/densityBefore[cell] - kineticBefore);
    scalarEntry("internal_energy_after_convection", convectedEnergy/density[cell] - kineticInviscid);
    scalarEntry("internal_energy_after_viscous_momentum", convectedEnergy/density[cell] - kineticAfter);
    scalarEntry("internal_energy_after_viscous_work", internalEnergy[cell]);
    std::cout << "}" << std::endl;
}
