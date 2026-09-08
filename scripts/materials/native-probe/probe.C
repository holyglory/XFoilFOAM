#include "psiThermo.H"
#include "IFstream.H"
#include "dictionary.H"
#include "scalarList.H"
#include "specie.H"
#include "perfectGas.H"
#include "janafThermo.H"
#include "sensibleInternalEnergy.H"
#include "thermo.H"
#include "polynomialTransport.H"
#include <iomanip>
#include <iostream>

using NativeGas = Foam::polynomialTransport<
    Foam::species::thermo<
        Foam::janafThermo<Foam::perfectGas<Foam::specie>>,
        Foam::sensibleInternalEnergy
    >
>;

int main(int argc, char** argv)
{
    if (argc != 2) return 2;
    auto* table = Foam::psiThermo::fvMeshConstructorTablePtr_;
    if (!table) return 3;
    unsigned matches = 0;
    for (const auto& name : table->sortedToc())
    {
        if (name.find("hePsiThermo") != std::string::npos
            && name.find("polynomial") != std::string::npos
            && name.find("janaf") != std::string::npos
            && name.find("perfectGas") != std::string::npos
            && name.find("sensibleInternalEnergy") != std::string::npos)
        {
            ++matches;
        }
    }
    if (matches != 1) return 4;
    Foam::IFstream input(argv[1]);
    Foam::dictionary specification(input);
    NativeGas material(specification.subDict("mixture"));
    const auto pressure = specification.get<Foam::scalar>("pressure");
    const Foam::scalarList temperatures(specification.lookup("temperatures"));
    std::cout << std::setprecision(17) << "{\"registered_combinations\":" << matches
        << ",\"universal_gas_constant\":" << Foam::constant::thermodynamic::RR << ",\"samples\":[";
    bool first = true;
    for (const auto temperature : temperatures)
    {
        if (!first) std::cout << ',';
        first = false;
        std::cout << "{\"temperature_k\":" << temperature
            << ",\"dynamic_viscosity\":" << material.mu(pressure, temperature)
            << ",\"thermal_conductivity\":" << material.kappa(pressure, temperature)
            << ",\"heat_capacity\":" << material.Cp(pressure, temperature)
            << ",\"enthalpy\":" << material.Ha(pressure, temperature)
            << ",\"entropy\":" << material.S(pressure, temperature)
            << ",\"density\":" << material.rho(pressure, temperature) << '}';
    }
    std::cout << "]}\n";
    return 0;
}
